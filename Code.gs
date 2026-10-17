/**
 * מכללת וולט — שרת שאלות ל-Claude (Google Apps Script)
 *
 * התקנה:
 * 1. script.google.com → פרויקט חדש → הדביקו את הקובץ הזה במקום Code.gs.
 * 2. Project Settings → Script Properties → הוסיפו ANTHROPIC_API_KEY עם המפתח שלכם.
 * 3. Deploy → New deployment → Web app
 *      Execute as: Me
 *      Who has access: Anyone
 * 4. העתיקו את כתובת ה-Web app (מסתיימת ב-/exec) לשדה CONFIG.webhookUrl בקובץ index.html.
 */

const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 1200;
const DAILY_LIMIT = 400;          // מכסת שאלות יומית לכל האתר, כדי לשלוט בעלות
const MAX_QUESTION_CHARS = 2000;
const MAX_IMAGE_B64 = 5 * 1024 * 1024;   // כ-3.7MB של תמונה; הדפדפן כבר מקטין ל-1600 פיקסלים

const SYSTEM = [
  'אתה מרצה סבלני במכללה להנדסאי חשמל בישראל.',
  'המסלול: שנה א יסודות (תורת החשמל, מתמטיקה, אלקטרוניקה, מערכות ספרתיות),',
  'שנה ב מכונות חשמל ובקרת הספק, שנה ג מערכות הספק ומתקני חשמל, ופרויקט גמר.',
  'ענה בעברית, קצר וברור, ברמה של סטודנט להנדסאי.',
  'בשאלת חישוב: כתוב את הנוסחה, הצב מספרים עם יחידות, ותן תוצאה סופית.',
  'כשסטודנט מבקש פתרון לשיעורי בית, הדרך אותו צעד אחר צעד במקום לתת רק תשובה.',
  'אם השאלה נוגעת לתקנות החשמל, ציין שהערכים צריכים אימות מול נוסח התקנות העדכני.',
  'אל תמציא נתונים. אם השאלה לא קשורה ללימודי חשמל, הפנה בנימוס חזרה לחומר.'
].join(' ');

function doGet() {
  return json_({ ok: true, service: 'volt-college-tutor' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const question = String(body.question || '').trim().slice(0, MAX_QUESTION_CHARS);
    if (!question) return json_({ error: 'השאלה ריקה.' });

    const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
    if (!key) return json_({ error: 'המפתח של Claude לא הוגדר בשרת.' });

    if (!takeQuota_()) return json_({ error: 'הגענו למכסת השאלות היומית. נסו שוב מחר.' });

    const context = String(body.context || '').slice(0, 3000);
    const messages = cleanHistory_(body.history);
    const text = (context ? context + '\n\n' : '') + 'שאלה: ' + question;
    const image = body.image;
    if (image) {
      const okType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].indexOf(image.media_type) !== -1;
      if (!okType || typeof image.data !== 'string' || image.data.length > MAX_IMAGE_B64) {
        return json_({ error: 'התמונה גדולה מדי או בפורמט לא נתמך.' });
      }
      messages.push({ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } },
        { type: 'text', text: 'הסטודנט צירף תמונה של שאלה. קרא אותה בעיון, כולל שרטוטים ומספרים.\n' + text }
      ] });
    } else {
      messages.push({ role: 'user', content: text });
    }

    const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, messages: messages }),
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();
    if (code !== 200) {
      console.error('Anthropic API ' + code + ': ' + res.getContentText());
      return json_({ error: code === 429 ? 'השרת עמוס כרגע. נסו שוב בעוד דקה.' : 'שגיאה בשרת (' + code + '). נסו שוב.' });
    }
    const data = JSON.parse(res.getContentText());
    const answer = (data.content || []).filter(function (c) { return c.type === 'text'; })
      .map(function (c) { return c.text; }).join('\n').trim();
    return json_({ answer: answer || 'לא התקבלה תשובה. נסו לנסח מחדש.' });
  } catch (err) {
    console.error(err);
    return json_({ error: 'שגיאה בעיבוד השאלה.' });
  }
}

/** היסטוריה מהדפדפן: רק תורות תקינות, מתחילה ב-user ומתחלפת. */
function cleanHistory_(h) {
  const out = [];
  (Array.isArray(h) ? h.slice(-6) : []).forEach(function (m) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return;
    if (out.length && out[out.length - 1].role === m.role) return;
    out.push({ role: m.role, content: m.content.slice(0, 3000) });
  });
  while (out.length && out[0].role !== 'user') out.shift();
  if (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

/** מונה יומי לכל האתר. */
function takeQuota_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
    if (props.getProperty('quota_day') !== today) {
      props.setProperties({ quota_day: today, quota_count: '0' });
    }
    const n = Number(props.getProperty('quota_count') || 0);
    if (n >= DAILY_LIMIT) return false;
    props.setProperty('quota_count', String(n + 1));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
