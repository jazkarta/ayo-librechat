const openIdClient = require('openid-client');
const { logger } = require('@librechat/data-schemas');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');

const getBaseUrl = () => process.env.AYO_API_URL;

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
  }
  return tokenset.access_token;
};

/**
 * @param {string} token
 * @param {{ conversationId: string, modelName: string }} params
 */
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

/**
 * @param {string} token
 * @param {{ conversationId: string, userEmail: string, modelName: string, prompt: string, response: string, attachments?: Array<{filename: string, type: string, url: string}> }} params
 */
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
    const err = new Error(`createChat failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

/**
 * @param {string} accessToken
 * @param {{ conversationId: string, title: string }} params
 */
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
    throw new Error(`updateConversationTitle failed: ${res.status}`);
  }
  return res.json();
};

/**
 * Saves a completed chat turn to ayo-dashboard.
 * Creates the conversation record first (only for new convos), then the chat record.
 * Fires as non-blocking — errors are logged but do not affect the LibreChat response.
 *
 * @param {object} params
 * @param {object} params.req
 * @param {string} params.accessToken
 * @param {string} [params.refreshToken]
 * @param {string} params.conversationId
 * @param {string} params.userEmail
 * @param {string} params.modelName
 * @param {string} params.prompt
 * @param {string} params.response
 * @param {boolean} params.isNewConvo
 * @param {Array<{filename: string, type: string, url: string}>} [params.attachments]
 */
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
    logger.warn('[ayoDashboard] AYO_API_URL not set, skipping sync');
    return;
  }
  if (!accessToken) {
    logger.warn('[ayoDashboard] No access token available, skipping sync');
    return;
  }

  let token = accessToken;

  const withRefresh = async (fn) => {
    try {
      return await fn(token);
    } catch (err) {
      if (err.status === 401 && refreshToken) {
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
    logger.error('[ayoDashboard] syncChatToAyo error', err);
  }
};

module.exports = { syncChatToAyo, updateConversationTitle };
