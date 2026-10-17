# מכללת וולט — הנדסאי חשמל

אתר לימוד וירטואלי לשנים א–ג ולפרויקט הגמר, עם עוזר שאלות.

## איך העוזר עונה

1. **המאגר של המכללה.** השאלה נבדקת מול מאגר תשובות מוכן שנמצא בתוך `index.html` (המערך `KB`). אם נמצאה התאמה טובה, התשובה מוצגת מיד.
2. **Claude.** אם אין התאמה, או שהסטודנט לוחץ "שאלה ל-Claude בכל זאת", השאלה נשלחת ל-Claude דרך Google Apps Script.

שאלה בתמונה (צילום או גלריה) עוברת ישר ל-Claude. הדפדפן מקטין את התמונה ל-1600 פיקסלים לפני השליחה.

כשהשדה `webhookUrl` ריק, העוזר עונה מהמאגר בלבד.

## קבצים

| קובץ | תפקיד |
|---|---|
| `index.html` | כל האתר בקובץ אחד: עמודים, תוכנית לימודים, מאגר תשובות ועוזר |
| `Code.gs` | שרת ב-Google Apps Script שמחזיק את המפתח וקורא ל-Claude |

## העלאה ל-GitHub Pages

1. יוצרים ריפו חדש, למשל `volt-college`, תחת החשבון `spektorone-alt`.
2. מעלים אליו את `index.html`.
3. Settings → Pages → Branch: `main`, תיקייה `/ (root)` → Save.
4. אחרי דקה האתר זמין בכתובת `https://spektorone-alt.github.io/volt-college/`.

## חיבור Claude

1. נכנסים ל-script.google.com ופותחים פרויקט חדש. מדביקים את התוכן של `Code.gs`.
2. Project Settings → Script Properties → מוסיפים `ANTHROPIC_API_KEY`.
3. Deploy → New deployment → Web app. מגדירים Execute as: **Me** ו-Who has access: **Anyone**.
4. מעתיקים את כתובת ה-Web app, שמסתיימת ב-`/exec`, לשדה `webhookUrl` בראש הסקריפט ב-`index.html`:
   ```js
   const CONFIG = {
     webhookUrl: "https://script.google.com/macros/s/.../exec",
   ```
5. מעלים מחדש את `index.html` ל-GitHub.

המכסה היומית מוגדרת ל-400 שאלות לכל האתר (`DAILY_LIMIT` ב-`Code.gs`). כך העלות נשארת בשליטה.

## הוספת תוכן

- **פרק או קורס:** עורכים את המערך `YEARS` בקובץ `index.html`.
- **תשובה למאגר:** מוסיפים שורה ל-`KB`:
  ```js
  {c:"machines", q:"השאלה כפי שתוצג", k:"מילות מפתח מופרדות ברווח", a:"התשובה. **הדגשה** ושורות חדשות עם \n"}
  ```
  השדה `c` הוא מזהה הקורס: `dc`, `ac`, `math`, `elec`, `digital`, `machines`, `power`, `psys`, `install`, `projects`.
- **רגישות החיפוש:** הערך `kbThreshold` הוא אחוז מילות השאלה שחייבות להתאים. ברירת המחדל היא 0.6. ערך גבוה יותר מעביר יותר שאלות ל-Claude.
