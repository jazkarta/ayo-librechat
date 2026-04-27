const { logger } = require('@librechat/data-schemas');

const getBaseUrl = () => process.env.AYO_API_URL;

/**
 * @param {string} accessToken
 * @param {{ conversationId: string, modelName: string }} params
 */
const createConversation = async (accessToken, { conversationId, modelName }) => {
  const url = `${getBaseUrl()}/api/chats/conversations/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ conversation_id: conversationId, model_name: modelName }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`createConversation failed: ${res.status} ${body}`);
  }
  return res.json();
};

/**
 * @param {string} accessToken
 * @param {{ conversationId: string, userEmail: string, modelName: string, prompt: string, response: string }} params
 */
const createChat = async (accessToken, { conversationId, userEmail, modelName, prompt, response }) => {
  const url = `${getBaseUrl()}/api/chats/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      conversation_id: conversationId,
      user_email: userEmail,
      model_name: modelName,
      prompt,
      response,
    }),
  });
  if (!res.ok) {
    throw new Error(`createChat failed: ${res.status}`);
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
 * @param {string} params.accessToken
 * @param {string} params.conversationId
 * @param {string} params.userEmail
 * @param {string} params.modelName
 * @param {string} params.prompt
 * @param {string} params.response
 * @param {boolean} params.isNewConvo
 */
const syncChatToAyo = async ({
  accessToken,
  conversationId,
  userEmail,
  modelName,
  prompt,
  response,
  isNewConvo,
}) => {
  if (!getBaseUrl()) {
    logger.warn('[ayoDashboard] AYO_API_URL not set, skipping sync');
    return;
  }
  if (!accessToken) {
    logger.warn('[ayoDashboard] No access token available, skipping sync');
    return;
  }

  try {
    if (isNewConvo) {
      await createConversation(accessToken, { conversationId, modelName });
    }
    await createChat(accessToken, { conversationId, userEmail, modelName, prompt, response });
  } catch (err) {
    logger.error('[ayoDashboard] syncChatToAyo error', err);
  }
};

module.exports = { syncChatToAyo, updateConversationTitle };
