const crypto = require('node:crypto');

const DEVICE_COOKIE = 'kugompo_device';
const LEADERBOARD_KEY = 'kugompo:leaderboard:v1';
const DEVICE_COOKIE_MAX_AGE = 10 * 365 * 24 * 60 * 60;

const FINISH_ATTEMPT_SCRIPT = `
local rawAttempt = redis.call('GET', KEYS[1])
if not rawAttempt then
  return cjson.encode({ error = 'not_started' })
end

local attempt = cjson.decode(rawAttempt)
local submitted = cjson.decode(ARGV[1])
if attempt.name ~= submitted.name then
  return cjson.encode({ error = 'name_mismatch' })
end

if attempt.status == 'finished' then
  if not attempt.submission
    or attempt.submission.score ~= submitted.score
    or attempt.submission.timeTaken ~= submitted.submissionTimeTaken then
    return cjson.encode({ error = 'already_finished' })
  end
  local currentScores = redis.call('GET', KEYS[2]) or '[]'
  return cjson.encode({ leaderboard = cjson.decode(currentScores), replay = true })
end

if attempt.status ~= 'started' then
  return cjson.encode({ error = 'not_started' })
end

local submissionTimeTaken = submitted.submissionTimeTaken
submitted.submissionTimeTaken = nil
local elapsed = math.max(0, math.floor((tonumber(ARGV[2]) - attempt.startedAt) / 1000))
submitted.timeTaken = math.max(submitted.timeTaken, elapsed)

local rawScores = redis.call('GET', KEYS[2])
local scores = rawScores and cjson.decode(rawScores) or {}
table.insert(scores, submitted)
table.sort(scores, function(a, b)
  if a.score ~= b.score then
    return a.score > b.score
  end
  if a.timeTaken ~= b.timeTaken then
    return a.timeTaken < b.timeTaken
  end
  if a.timestamp ~= b.timestamp then
    return a.timestamp < b.timestamp
  end
  return a.name < b.name
end)
while #scores > 10 do
  table.remove(scores)
end

attempt.status = 'finished'
attempt.submission = {
  score = submitted.score,
  timeTaken = submissionTimeTaken
}
redis.call('SET', KEYS[2], cjson.encode(scores))
redis.call('SET', KEYS[1], cjson.encode(attempt))
return cjson.encode({ leaderboard = scores, replay = false })
`;

function redisCredentials() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Leaderboard storage is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.');
  }
  return { url: url.replace(/\/+$/, ''), token };
}

async function redisCommand(command) {
  const { url, token } = redisCredentials();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const result = await response.json();
  if (!response.ok || result.error) {
    throw new Error(result.error || `Leaderboard storage returned HTTP ${response.status}.`);
  }
  return result.result;
}

function readDeviceId(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${DEVICE_COOKIE}=`));
  const value = cookie ? cookie.slice(DEVICE_COOKIE.length + 1) : '';
  return /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function setDeviceCookie(req, res, deviceId) {
  const isHttps = req.headers['x-forwarded-proto'] === 'https';
  const secure = isHttps ? '; Secure' : '';
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
    not_started: 'Start a new attempt before submitting a score.'
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
  const attemptKey = `kugompo:attempt:${deviceId}`;

  try {
    if (req.method === 'GET') {
      const [leaderboardValue, attemptValue] = await Promise.all([
        redisCommand(['GET', LEADERBOARD_KEY]),
        redisCommand(['GET', attemptKey])
      ]);
      const leaderboard = leaderboardValue ? JSON.parse(leaderboardValue) : [];
      const attempt = attemptValue ? JSON.parse(attemptValue) : null;
      if (!Array.isArray(leaderboard)) {
        throw new Error('Stored leaderboard data is invalid.');
      }
      return sendJson(res, 200, {
        leaderboard,
        hasUsedAttempt: Boolean(attempt),
        attemptStatus: attempt ? attempt.status : null
      });
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
      const name = body.name.trim();
      const result = await redisCommand([
        'SET',
        attemptKey,
        JSON.stringify({ status: 'started', name, startedAt: Date.now() }),
        'NX'
      ]);
      if (result !== 'OK') {
        return sendJson(res, 409, {
          code: 'already_played',
          error: publicError('already_played')
        });
      }
      return sendJson(res, 200, { name });
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

      const name = body.name.trim();
      const entry = {
        name,
        score: body.score,
        timeTaken: body.timeTaken,
        submissionTimeTaken: body.timeTaken,
        timestamp: new Date().toISOString()
      };
      const result = await redisCommand([
        'EVAL',
        FINISH_ATTEMPT_SCRIPT,
        '2',
        attemptKey,
        LEADERBOARD_KEY,
        JSON.stringify(entry),
        String(Date.now())
      ]);
      const outcome = JSON.parse(result);
      if (outcome.error) {
        return sendJson(res, 409, {
          code: outcome.error,
          error: publicError(outcome.error)
        });
      }
      return sendJson(res, 200, { leaderboard: outcome.leaderboard });
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
