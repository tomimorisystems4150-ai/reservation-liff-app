/**
 * E2Eテスト共通ヘルパー関数
 */

/**
 * GAS APIに直接リクエストを送信する（APIテスト用）
 */
async function callGasApi(request, action, payload = {}) {
  const gasApiUrl = process.env.GAS_API_URL;
  if (!gasApiUrl) throw new Error('GAS_API_URL が設定されていません（.env.test を確認してください）');

  const response = await request.post(gasApiUrl, {
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    data: JSON.stringify({ action, ...payload }),
  });

  const body = await response.json();
  return body;
}

/**
 * テスト用の未来日時文字列を生成する（offsetDays日後の14:00 JST）
 */
function getFutureDateTime(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(14, 0, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T14:00:00+09:00`;
}

/**
 * テスト用の未来日付文字列（yyyy-MM-dd形式）
 */
function getFutureDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * LIFFページのフルURLを取得する
 */
function getLiffUrl() {
  return process.env.LIFF_FULL_URL || '';
}

module.exports = { callGasApi, getFutureDateTime, getFutureDate, getLiffUrl };
