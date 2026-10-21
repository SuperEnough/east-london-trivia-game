const crypto = require('node:crypto');

const DEVICE_COOKIE = 'kugompo_device';
const DEVICE_COOKIE_MAX_AGE = 10 * 365 * 24 * 60 * 60;

function supabaseCredentials() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Leaderboard storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

async function callSupabaseRpc(functionName, parameters) {
  const { url, serviceRoleKey } = supabaseCredentials();
  const response = await fetch(`${url}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(parameters)
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase RPC ${functionName} failed (${response.status}): ${responseBody}`);
  }
  try {
    return JSON.parse(responseBody);
  } catch {
    throw new Error(`Supabase RPC ${functionName} returned invalid JSON.`);
  }
}

function readDeviceId(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${DEVICE_COOKIE}=`));
  const value = cookie ? cookie.slice(DEVICE_COOKIE.length + 1) : '';
  return /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function setDeviceCookie(req, res, deviceId) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${DEVICE_COOKIE}=${deviceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_COOKIE_MAX_AGE}${secure}`
  );
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function parseBody(body) {
  if (typeof body === 'string') {
    return JSON.parse(body);
  }
  return body && typeof body === 'object' ? body : {};
}

function validateName(name) {
  return typeof name === 'string'
    && name.trim().length > 0
    && name.trim().length <= 20
    && !/[\u0000-\u001f\u007f]/.test(name);
}

function publicError(code) {
  const messages = {
    already_played: 'This browser has already used its one attempt.',
    already_finished: 'This attempt has already been submitted.',
    name_mismatch: 'The player name must match the name used to start.',
    not_started: 'Start a new attempt before submitting a score.',
    invalid_name: 'Enter a player name of 1 to 20 characters.',
    invalid_submission: 'The submitted score or completion time is invalid.'
  };
  return messages[code] || 'The leaderboard request could not be completed.';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  let deviceId = readDeviceId(req);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    setDeviceCookie(req, res, deviceId);
  }

  try {
    if (req.method === 'GET') {
      const result = await callSupabaseRpc('get_quiz_leaderboard', {
        p_device_id: deviceId
      });
      if (!result || !Array.isArray(result.leaderboard) || typeof result.hasUsedAttempt !== 'boolean') {
        throw new Error('Supabase returned invalid leaderboard data.');
      }
      return sendJson(res, 200, result);
    }

    let body;
    try {
      body = parseBody(req.body);
    } catch {
      return sendJson(res, 400, { error: 'The request body must be valid JSON.' });
    }

    if (body.action === 'start') {
      if (!validateName(body.name)) {
        return sendJson(res, 400, { error: 'Enter a player name of 1 to 20 characters.' });
      }
      const result = await callSupabaseRpc('start_quiz_attempt', {
        p_device_id: deviceId,
        p_name: body.name.trim()
      });
      if (result.error) {
        return sendJson(res, 409, {
          code: result.error,
          error: publicError(result.error)
        });
      }
      return sendJson(res, 200, { name: result.name });
    }

    if (body.action === 'finish') {
      if (!validateName(body.name)
        || !Number.isSafeInteger(body.score)
        || body.score < 0
        || body.score > 100
        || body.score % 10 !== 0
        || !Number.isSafeInteger(body.timeTaken)
        || body.timeTaken < 0
        || body.timeTaken > 86400) {
        return sendJson(res, 400, { error: 'The submitted score or completion time is invalid.' });
      }

      const result = await callSupabaseRpc('finish_quiz_attempt', {
        p_device_id: deviceId,
        p_name: body.name.trim(),
        p_score: body.score,
        p_time_taken: body.timeTaken
      });
      if (result.error) {
        return sendJson(res, 409, {
          code: result.error,
          error: publicError(result.error)
        });
      }
      if (!Array.isArray(result.leaderboard)) {
        throw new Error('Supabase returned invalid leaderboard data after score submission.');
      }
      return sendJson(res, 200, { leaderboard: result.leaderboard });
    }

    return sendJson(res, 400, { error: 'Unknown leaderboard action.' });
  } catch (error) {
    console.error('Leaderboard API error:', error);
    const message = error.message.includes('not configured')
      ? error.message
      : 'The shared leaderboard is unavailable. Please try again later.';
    return sendJson(res, 503, { error: message });
  }
};
