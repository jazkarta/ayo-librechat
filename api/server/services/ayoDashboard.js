const openIdClient = require('openid-client');
const { getMessages } = require('~/models');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');

const getBaseUrl = () => process.env.AYO_API_URL;

const getCurrentUserInfo = async (token) => {
  const url = `${getBaseUrl()}/api/users/me/`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`getCurrentUserInfo failed: ${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

/** Decode JWT exp claim without verifying signature. Returns true if expired or undecodable. */
const isTokenExpired = (token) => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.exp < Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
};

const refreshAccessToken = async (req, refreshToken) => {
  const openIdConfig = getOpenIdConfig();
  const refreshParams = process.env.OPENID_SCOPE ? { scope: process.env.OPENID_SCOPE } : {};
  const tokenset = await openIdClient.refreshTokenGrant(openIdConfig, refreshToken, refreshParams);
  if (req?.session) {
    req.session.openidTokens = {
      ...req.session.openidTokens,
      accessToken: tokenset.access_token,
      idToken: tokenset.id_token,
      refreshToken: tokenset.refresh_token || refreshToken,
    };
    await new Promise((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
  }
  return tokenset.access_token;
};

const createConversation = async (token, { conversationId, modelName }) => {
  const url = `${getBaseUrl()}/api/chats/conversations/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ conversation_id: conversationId, model_name: modelName }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`createConversation failed: ${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

const createChat = async (token, { conversationId, userEmail, modelName, prompt, response, attachments = [] }) => {
  const url = `${getBaseUrl()}/api/chats/`;
  const body = {
    conversation_id: conversationId,
    user_email: userEmail,
    model_name: modelName,
    prompt,
    response,
  };
  if (attachments.length > 0) {
    body.attachments = attachments;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`createChat failed: ${res.status} ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

const updateConversationTitle = async (accessToken, { conversationId, title }) => {
  const url = `${getBaseUrl()}/api/chats/conversations/update-title/`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ conversation_id: conversationId, title }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`updateConversationTitle failed: ${res.status} ${body}`);
  }
  return res.json();
};

const extractResponseText = (msg) => {
  if (!msg) return null;
  if (msg.text) return msg.text;
  if (Array.isArray(msg.content)) {
    const textPart = msg.content.find((b) => b.type === 'text');
    if (textPart?.text) return textPart.text;
    const errorPart = msg.content.find((b) => b.type === 'error');
    if (errorPart?.error) {
      const raw = errorPart.error.split('\n')[0];
      return `[Error] ${raw.length > 150 ? raw.slice(0, 150) + '...' : raw}`;
    }
  }
  return null;
};

const backfillConversationToAyo = async ({ withRefresh, conversationId, modelName, userEmail }) => {
  const messages = await getMessages({ conversationId });
  const userMessages = messages.filter((m) => m.isCreatedByUser);

  await withRefresh((t) => createConversation(t, { conversationId, modelName }));

  for (const userMsg of userMessages) {
    const assistantMsg = messages.find(
      (m) => !m.isCreatedByUser && m.parentMessageId === userMsg.messageId,
    );
    const responseText = extractResponseText(assistantMsg) || '[Error] No response was generated.';
    const attachments = (userMsg.files ?? [])
      .filter((f) => f.filename && f.type && f.filepath)
      .map((f) => ({ filename: f.filename, type: f.type, url: f.filepath }));

    try {
      await withRefresh((t) =>
        createChat(t, {
          conversationId,
          userEmail,
          modelName,
          prompt: userMsg.text || '',
          response: responseText,
          attachments,
        }),
      );
    } catch (chatErr) {
      console.error('[ayoDashboard] Failed to sync message during backfill:', {
        conversationId,
        messageId: userMsg.messageId,
        message: chatErr.message,
      });
    }
  }

  console.log(`[ayoDashboard] Backfilled ${userMessages.length} chat(s) for conversation: ${conversationId}`);
};

const syncChatToAyo = async ({
  req,
  accessToken,
  refreshToken,
  conversationId,
  userEmail,
  modelName,
  prompt,
  response,
  isNewConvo,
  attachments = [],
}) => {
  if (!getBaseUrl()) {
    console.warn('[ayoDashboard] AYO_API_URL not set, skipping sync');
    return;
  }

  if (!accessToken) {
    console.warn('[ayoDashboard] No access token available, skipping sync');
    return;
  }

  let token = accessToken;

  if (isTokenExpired(token) && refreshToken) {
    console.log('[ayoDashboard] Access token expired, refreshing proactively');
    token = await refreshAccessToken(req, refreshToken);
  }

  const withRefresh = async (fn) => {
    try {
      return await fn(token);
    } catch (err) {
      if ((err.status === 401 || err.status === 403) && refreshToken) {
        console.log('[ayoDashboard] Token rejected, retrying with refreshed token');
        token = await refreshAccessToken(req, refreshToken);
        return fn(token);
      }
      throw err;
    }
  };

  try {
    if (isNewConvo) {
      await withRefresh((t) => createConversation(t, { conversationId, modelName }));
    }
    await withRefresh((t) => createChat(t, { conversationId, userEmail, modelName, prompt, response, attachments }));
  } catch (err) {
    if (err.status === 400 && err.message?.includes('does not exist')) {
      console.log('[ayoDashboard] Conversation missing in Django, backfilling from MongoDB:', conversationId);
      try {
        await backfillConversationToAyo({ withRefresh, conversationId, modelName, userEmail });
      } catch (backfillErr) {
        console.error('[ayoDashboard] Backfill failed:', { conversationId, message: backfillErr.message });
      }
    } else {
      console.error('[ayoDashboard] Failed to sync chat turn:', { conversationId, status: err.status, message: err.message });
    }
  }
};

module.exports = { syncChatToAyo, updateConversationTitle, refreshAccessToken, isTokenExpired, getCurrentUserInfo, extractResponseText };
