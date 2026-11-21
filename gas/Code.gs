/**
 * Đọc sách – Apps Script đọc ảnh bìa bằng Gemini.
 * App gửi: { token: <access token Google của app>, image: <ảnh JPEG base64> }
 * Trả về:  { ok: true, data: { title, series, volume, author, translator, publisher } } hoặc { ok: false, error }
 *
 * Cài đặt (một lần):
 *  1. Project Settings → Script Properties → thêm GEMINI_API_KEY = <key lấy ở aistudio.google.com>
 *  2. (Tuỳ chọn) GEMINI_MODEL = model muốn thử đầu tiên. Bỏ trống thì script tự lập danh sách model "flash" và thử lần lượt.
 *  3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → copy URL dán vào app.
 */

const ALLOWED_EMAIL = 'luannguyen113@gmail.com';
const CLIENT_ID = '878030336042-18q2nhn7ihp8i42galb3gljgtf45uib4.apps.googleusercontent.com';

function doPost(e) {
  const t0 = Date.now();
  const ms = {};
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    checkCaller_(body.token);
    ms.auth = Date.now() - t0;
    if (!body.image) throw new Error('Thiếu ảnh');
    const data = readCover_(body.image, ms);
    ms.total = Date.now() - t0;
    console.log('Đọc bìa xong', JSON.stringify(ms));
    return json_({ ok: true, data: data, ms: ms });
  } catch (err) {
    ms.total = Date.now() - t0;
    console.error('Lỗi đọc bìa', String(err.message || err), JSON.stringify(ms));
    return json_({ ok: false, error: String(err.message || err), ms: ms });
  }
}

// Chỉ chấp nhận yêu cầu từ app Đọc sách, đăng nhập bằng đúng tài khoản Google của chủ app.
function checkCaller_(token) {
  if (!token) throw new Error('Thiếu token đăng nhập');
  // Token đã xác minh thì nhớ 50 phút, khỏi gọi Google kiểm tra lại mỗi lần.
  const cache = CacheService.getScriptCache();
  const ck = 'ok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  if (cache.get(ck)) return;
  const info = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (info.getResponseCode() !== 200) throw new Error('Token không hợp lệ hoặc đã hết hạn');
  const ti = JSON.parse(info.getContentText());
  if (ti.aud !== CLIENT_ID && ti.azp !== CLIENT_ID) throw new Error('Token không phải của app Đọc sách');
  const about = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
  });
  if (about.getResponseCode() !== 200) throw new Error('Không xác minh được tài khoản');
  const email = JSON.parse(about.getContentText()).user.emailAddress;
  if (String(email).toLowerCase() !== ALLOWED_EMAIL) throw new Error('Tài khoản không được phép');
  cache.put(ck, '1', 3000);
}

function readCover_(b64, ms) {
  const t0 = Date.now();
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Chưa cài GEMINI_API_KEY trong Script Properties');
  const models = pickModels_(key);
  ms.model = Date.now() - t0;
  const prompt = [
    'Đây là ảnh chụp bìa trước một cuốn sách hoặc một tập truyện tranh (thường là sách phát hành tại Việt Nam).',
    'Hãy đọc đúng chữ in trên bìa và trả về JSON với các trường:',
    '- title: tên sách đúng như in trên bìa, giữ nguyên dấu tiếng Việt, viết hoa chữ cái đầu mỗi câu/tên riêng như bình thường (không viết hoa toàn bộ). Với truyện tranh nhiều tập: tên bộ truyện, KHÔNG kèm số tập.',
    '- series: tên bộ nếu là truyện/sách nhiều tập, ngược lại null.',
    '- volume: số tập (số nguyên) nếu bìa có ghi, ngược lại null.',
    '- author: tác giả (viết hoa chữ cái đầu, ví dụ "Kurt Vonnegut").',
    '- translator: người dịch nếu bìa ghi "... dịch", ngược lại null.',
    '- publisher: nhà xuất bản / đơn vị phát hành in trên bìa (nối bằng " · " nếu có nhiều), ngược lại null.',
    'Không đoán thông tin không có trên ảnh: thiếu thì để null.',
  ].join('\n');
  const payload = {
    contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING', nullable: true },
          series: { type: 'STRING', nullable: true },
          volume: { type: 'INTEGER', nullable: true },
          author: { type: 'STRING', nullable: true },
          translator: { type: 'STRING', nullable: true },
          publisher: { type: 'STRING', nullable: true },
        },
      },
    },
  };
  const t1 = Date.now();
  const tried = [];
  let res = null;
  // Thử lần lượt các model; model nào bận (503/429/500) hoặc không còn (404) thì chuyển model kế tiếp.
  for (let i = 0; i < models.length && Date.now() - t1 < 40000; i++) {
    const model = models[i];
    res = callGemini_(model, key, payload);
    if (res.getResponseCode() === 503 && i === 0) { Utilities.sleep(1500); res = callGemini_(model, key, payload); }
    tried.push(model + ':' + res.getResponseCode());
    if (res.getResponseCode() === 200) { ms.modelName = model; break; }
    if (res.getResponseCode() === 404) PropertiesService.getScriptProperties().deleteProperty('AUTO_MODELS');
    if ([429, 500, 503, 404].indexOf(res.getResponseCode()) < 0) break; // lỗi khác (key sai...) thì dừng
  }
  ms.gemini = Date.now() - t1;
  ms.tried = tried.join(', ');
  if (!res || res.getResponseCode() !== 200) {
    const code = res ? res.getResponseCode() : 0;
    if (code === 503 || code === 429) throw new Error('Gemini đang quá tải ở tất cả model đã thử. Thử lại sau ít phút hoặc nhập tay.');
    throw new Error('Gemini lỗi ' + code + ': ' + (res ? res.getContentText().slice(0, 300) : ''));
  }
  const out = JSON.parse(res.getContentText());
  const text = out.candidates && out.candidates[0] && out.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
  if (!text) throw new Error('Gemini không trả kết quả');
  return JSON.parse(text);
}

// Gọi Gemini, tắt chế độ "suy nghĩ" cho nhanh; model không hỗ trợ tham số này thì gọi lại không có nó.
function callGemini_(model, key, payload) {
  const send = function (p) {
    return UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(p), muteHttpExceptions: true,
    });
  };
  const fast = JSON.parse(JSON.stringify(payload));
  fast.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  let res = send(fast);
  if (res.getResponseCode() === 400 && /thinking/i.test(res.getContentText())) {
    fast.generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    res = send(fast);
    if (res.getResponseCode() === 400 && /thinking/i.test(res.getContentText())) res = send(payload);
  }
  return res;
}

// Danh sách model thử lần lượt: GEMINI_MODEL (nếu đặt) → các bản "flash" ổn định, mới trước → bản preview → bản "flash-lite".
function pickModels_(key) {
  const props = PropertiesService.getScriptProperties();
  const fixed = props.getProperty('GEMINI_MODEL');
  const cached = props.getProperty('AUTO_MODELS');
  let auto = cached ? JSON.parse(cached) : null;
  if (!auto) {
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + key, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('Không lấy được danh sách model Gemini: ' + res.getContentText().slice(0, 200));
    const names = (JSON.parse(res.getContentText()).models || [])
      .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
      .map(function (m) { return m.name.replace('models/', ''); })
      .filter(function (n) { return /^gemini-[\d.]+-flash/.test(n) && !/(image|tts|audio|live|thinking|embedding)/.test(n); });
    const ver = function (n) { return parseFloat(n.match(/^gemini-([\d.]+)/)[1]); };
    const rank = function (n) { return (/lite/.test(n) ? 2 : 0) + (/(preview|exp)/.test(n) ? 1 : 0); };
    auto = names.sort(function (a, b) { return rank(a) - rank(b) || ver(b) - ver(a) || a.length - b.length; }).slice(0, 6);
    if (!auto.length) throw new Error('Không tìm thấy model Gemini flash phù hợp');
    props.setProperty('AUTO_MODELS', JSON.stringify(auto));
  }
  return fixed ? [fixed].concat(auto.filter(function (m) { return m !== fixed; })) : auto;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Chạy thử trong trình soạn thảo Apps Script để xem model được chọn.
function testModel() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('AUTO_MODELS');
  props.deleteProperty('AUTO_MODEL');
  Logger.log(pickModels_(props.getProperty('GEMINI_API_KEY')).join('\n'));
}
