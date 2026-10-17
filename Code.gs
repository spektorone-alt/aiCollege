/**
 * מכללת וולט — שרת שאלות ל-Claude (Google Apps Script)
 *
 * התקנה:
 * 1. script.google.com → פרויקט חדש → הדביקו את הקובץ הזה במקום Code.gs.
 * 2. Project Settings → Script Properties → הוסיפו ANTHROPIC_API_KEY עם המפתח שלכם.
 * 3. Deploy → New deployment → Web app
 *      Execute as: Me
 *      Who has access: Anyone
 * 4. בעורך בחרו את הפונקציה authorize ולחצו Run פעם אחת, כדי לאשר שליחת מיילים.
 * 5. העתיקו את כתובת ה-Web app (מסתיימת ב-/exec) לשדה CONFIG.webhookUrl בקובץ index.html.
 */

const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 1200;
const DAILY_LIMIT = 400;          // מכסת שאלות יומית לכל האתר, כדי לשלוט בעלות
const MAX_QUESTION_CHARS = 2000;
const EMAIL_DAILY_LIMIT = 90;    // Gmail רגיל מאפשר כ-100 נמענים ביום
const ANSWER_TTL = 21600;        // תשובה נשמרת 6 שעות לצורך שליחה במייל
const MAX_IMAGE_B64 = 5 * 1024 * 1024;   // כ-3.7MB של תמונה; הדפדפן כבר מקטין ל-1600 פיקסלים

const SYSTEM = [
  'שמך Volt, המערכת החכמה של מכללת וולט.',
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
    if (body.action === 'email') return sendAnswerEmail_(body);
    const question = String(body.question || '').trim().slice(0, MAX_QUESTION_CHARS);
    if (!question) return json_({ error: 'השאלה ריקה.' });

    const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
    if (!key) return json_({ error: 'המפתח של Claude לא הוגדר בשרת.' });

    if (!takeCounter_('q', DAILY_LIMIT)) return json_({ error: 'הגענו למכסת השאלות היומית. נסו שוב מחר.' });

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
    if (!answer) return json_({ answer: 'לא התקבלה תשובה. נסו לנסח מחדש.' });
    const id = Utilities.getUuid();
    CacheService.getScriptCache().put('ans_' + id, JSON.stringify({ q: question, a: answer, img: !!image }), ANSWER_TTL);
    return json_({ answer: answer, id: id });
  } catch (err) {
    console.error(err);
    return json_({ error: 'שגיאה בעיבוד השאלה.' });
  }
}

/** שליחת פתרון שנוצר בשרת למייל של הסטודנט. נשלחות רק תשובות שהשרת עצמו יצר. */
function sendAnswerEmail_(body) {
  const to = String(body.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 200) return json_({ error: 'כתובת המייל לא תקינה.' });
  const raw = CacheService.getScriptCache().get('ans_' + String(body.id || ''));
  if (!raw) return json_({ error: 'הפתרון כבר לא זמין לשליחה. שאלו שוב ושלחו מיד.' });
  if (!takeCounter_('mail', EMAIL_DAILY_LIMIT)) return json_({ error: 'הגענו למכסת המיילים היומית. שמרו את הפתרון כתמונה.' });
  const rec = JSON.parse(raw);
  const q = rec.img ? (rec.q + ' (שאלה מתמונה)') : rec.q;
  const html =
    '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.7;color:#10202f;max-width:640px">' +
    '<div style="background:#10202f;color:#fff;padding:14px 18px;border-bottom:4px solid #f2b705;font-size:20px;font-weight:bold">מכללת וולט</div>' +
    '<div style="padding:18px">' +
    '<div style="color:#0b5cad;font-size:19px;font-weight:bold;margin-bottom:12px">' + esc_(q) + '</div>' +
    mdToHtml_(rec.a) +
    '<p style="color:#526477;font-size:13px;margin-top:24px">הפתרון נוצר על ידי Volt, המערכת החכמה של מכללת וולט.</p>' +
    '</div></div>';
  MailApp.sendEmail({ to: to, subject: 'הפתרון שלך מ-Volt · מכללת וולט', htmlBody: html, body: q + '\n\n' + rec.a, name: 'מכללת וולט' });
  return json_({ ok: true });
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
function mdToHtml_(t) {
  return esc_(t).split('\n').map(function (l) {
    l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^#{1,4}\s*(.*)$/, '<b>$1</b>');
    const li = l.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    return li ? '&bull; ' + li[1] : l;
  }).join('<br>');
}

/** הרצה ידנית אחת מהעורך כדי לאשר הרשאת שליחת מיילים. */
function authorize() {
  console.log('מיילים שנותרו היום: ' + MailApp.getRemainingDailyQuota());
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

/** מונה יומי לכל האתר (שאלות או מיילים). */
function takeCounter_(name, limit) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd');
    if (props.getProperty(name + '_day') !== today) {
      props.setProperty(name + '_day', today);
      props.setProperty(name + '_count', '0');
    }
    const n = Number(props.getProperty(name + '_count') || 0);
    if (n >= limit) return false;
    props.setProperty(name + '_count', String(n + 1));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
