/**
 * Đọc sách – Apps Script đọc ảnh bìa bằng Gemini.
 * App gửi: { token: <access token Google của app>, image: <ảnh JPEG base64> }
 * Trả về:  { ok: true, data: { title, series, volume, author, translator, publisher } } hoặc { ok: false, error }
 *
 * Cài đặt (một lần):
 *  1. Project Settings → Script Properties → thêm GEMINI_API_KEY = <key lấy ở aistudio.google.com>
 *  2. (Tuỳ chọn) GEMINI_MODEL = tên model muốn dùng. Bỏ trống thì script tự chọn model "flash" mới nhất.
 *  3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → copy URL dán vào app.
 */

const ALLOWED_EMAIL = 'luannguyen113@gmail.com';
const CLIENT_ID = '878030336042-18q2nhn7ihp8i42galb3gljgtf45uib4.apps.googleusercontent.com';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    checkCaller_(body.token);
    if (!body.image) throw new Error('Thiếu ảnh');
    return json_({ ok: true, data: readCover_(body.image) });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

// Chỉ chấp nhận yêu cầu từ app Đọc sách, đăng nhập bằng đúng tài khoản Google của chủ app.
function checkCaller_(token) {
  if (!token) throw new Error('Thiếu token đăng nhập');
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
}

function readCover_(b64) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Chưa cài GEMINI_API_KEY trong Script Properties');
  const model = pickModel_(key);
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
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    // Model có thể đã bị ngừng: xoá lựa chọn đã lưu để lần sau chọn lại.
    PropertiesService.getScriptProperties().deleteProperty('AUTO_MODEL');
    throw new Error('Gemini lỗi ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const out = JSON.parse(res.getContentText());
  const text = out.candidates && out.candidates[0] && out.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
  if (!text) throw new Error('Gemini không trả kết quả');
  return JSON.parse(text);
}

// Dùng GEMINI_MODEL nếu có; không thì tự chọn model "flash" bản ổn định mới nhất hỗ trợ đọc ảnh, lưu lại để dùng tiếp.
function pickModel_(key) {
  const props = PropertiesService.getScriptProperties();
  const fixed = props.getProperty('GEMINI_MODEL');
  if (fixed) return fixed;
  const cached = props.getProperty('AUTO_MODEL');
  if (cached) return cached;
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + key, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Không lấy được danh sách model Gemini: ' + res.getContentText().slice(0, 200));
  const models = (JSON.parse(res.getContentText()).models || [])
    .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
    .map(function (m) { return m.name.replace('models/', ''); })
    .filter(function (n) { return /^gemini-[\d.]+-flash/.test(n) && !/(lite|image|tts|audio|live|thinking|embedding)/.test(n); });
  const ver = function (n) { return parseFloat(n.match(/^gemini-([\d.]+)/)[1]); };
  const stable = models.filter(function (n) { return !/(preview|exp)/.test(n); });
  const pool = (stable.length ? stable : models).sort(function (a, b) { return ver(b) - ver(a) || a.length - b.length; });
  if (!pool.length) throw new Error('Không tìm thấy model Gemini flash phù hợp');
  props.setProperty('AUTO_MODEL', pool[0]);
  return pool[0];
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Chạy thử trong trình soạn thảo Apps Script để xem model được chọn.
function testModel() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  Logger.log(pickModel_(key));
}
