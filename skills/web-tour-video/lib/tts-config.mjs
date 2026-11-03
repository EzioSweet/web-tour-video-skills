export const DEFAULT_BASE_URL = 'http://localhost:8735';

/** 环境变量优先于 storyboard 的 tts 字段。 */
export function buildTtsConfig(storyboardTts = {}) {
  const pick = (envName, sbValue, fallback = '') => {
    if (process.env[envName] !== undefined) return process.env[envName];
    if (sbValue !== undefined && sbValue !== null) return String(sbValue);
    return fallback;
  };
  return {
    baseUrl: pick('TTS_BASE_URL', storyboardTts.baseUrl, DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: pick('TTS_MODEL', storyboardTts.model, ''),
    voice: pick('TTS_VOICE', storyboardTts.voice, ''),
    apiKey: process.env.TTS_API_KEY || '',
    responseFormat: pick('TTS_RESPONSE_FORMAT', storyboardTts.responseFormat, 'mp3'),
  };
}
