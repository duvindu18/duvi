# Studio Morfis website: Namecheap hosting package

This folder is the complete website plus its admin panel, ready for Namecheap
shared hosting (Stellar, Stellar Plus or Stellar Business). It needs **PHP 8.0
or newer** and nothing else: no database, no build step, no command line.

- Everything inside `public_html/` gets uploaded to your hosting.
- `dev-router.php` and this README stay on your computer.

---

## 1. Put it online (about 20 minutes)

### 1.1 Domain and hosting
1. Buy the domain and a **Stellar** hosting plan at namecheap.com. If you buy them
   together, Namecheap connects the domain to the hosting for you.
2. If the domain was bought separately or elsewhere, set its nameservers to
   `dns1.namecheaphosting.com` and `dns2.namecheaphosting.com`
   (Domain List → Manage → Nameservers → *Custom DNS*). This can take a few hours.

### 1.2 Choose the PHP version
cPanel → **Select PHP Version** → choose **8.2** or **8.3** → *Set as current*.
On the **Extensions** tab make sure these are ticked: `gd`, `fileinfo`, `mbstring`,
`exif`, `intl` (most are on by default).

### 1.3 Upload the files
1. cPanel → **File Manager** → open `public_html`.
2. Delete the placeholder files Namecheap put there (e.g. `default.html`).
   Leave `cgi-bin` and `.well-known` alone.
3. Click **Upload** and upload `studio-morfis-namecheap.zip`.
4. Right-click the zip → **Extract** → extract into `/public_html`.
   Then delete the zip.
5. Check that the files sit directly in `public_html` (you should see `index.php`,
   `admin`, `css`, …), not inside an extra folder. If they landed in
   `public_html/public_html`, select everything inside it and **Move** it up one level.
6. Click **Settings** (top right) → tick **Show Hidden Files**, and confirm that
   `.htaccess` and `.user.ini` are present.

Folder permissions should be **755** and files **644**, which is what File Manager
uses by default. The website writes to `data/` and `uploads/`, and this works with
755 because PHP runs as your own cPanel user on Namecheap.

### 1.4 Turn on HTTPS
1. cPanel → **SSL/TLS Status** → select your domain → **Run AutoSSL**.
   Namecheap's free certificate is usually active within a few minutes to an hour.
2. When the padlock works at `https://yourdomain.com`, open `public_html/.htaccess`
   in File Manager → **Edit**, remove the `#` at the start of these two lines and save:
   ```
   # RewriteCond %{HTTPS} !=on
   # RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
   ```

### 1.5 Create your admin account
1. Go to `https://yourdomain.com/admin`. It asks for a **setup code**.
2. In File Manager open `public_html/data/setup-code.txt` and copy the code.
   (Only someone with access to your hosting can read it, so nobody else can claim
   the admin account first.)
3. Enter the code, a user name and a password of at least 10 characters.
   The code file is deleted automatically and you are signed in.

### 1.6 Email addresses
The Contact page shows `hello@`, `press@` and `careers@` addresses. Create them under
cPanel → **Email Accounts** (included with Stellar hosting) or with Namecheap Private
Email, or change the addresses in the admin panel.

### 1.7 Search engines
Submit `https://yourdomain.com/sitemap.xml` in Google Search Console. The sitemap and
`robots.txt` are generated automatically and only list published projects.

---

## 2. Using the admin panel (`/admin`)

| Section | What you can do |
| --- | --- |
| **Projects** | See every project with its cover. **Publish / Unpublish** with one click, change the order with ↑ ↓ (the order is the order on the home page and the numbers 01, 02… follow it), Edit, Preview, Delete. |
| **Project editor** | Title, web address, short description, type, year, status, location, area, client, team. Upload images (the first is the cover; the 2nd and 3rd appear in the book spread), write captions, reorder or remove them. Project text (empty line = new paragraph). Materials with a colour swatch. A **Published** switch. |
| **Site & home** | Studio name, descriptor, tagline, description, founding year, email, phone, **logo upload**, every text on the home page and the Index page intro, social links. |
| **Studio page** | Headline, introduction, the two images, principles, people, recognition. |
| **Contact page** | Headline, text, and extra contacts such as Press and Careers. |
| **Media** | All uploaded images, where each one is used, and deleting the ones that are no longer used. |
| **Account & backups** | Change the password, download all content as a file, and restore any of the last 40 saved versions. |

Tips:
- **Drafts** are invisible to visitors. While you are signed in you can open a draft's
  page to preview it; a small black bar marks it as a draft.
- In headlines, wrap a word in `*asterisks*` to set it in the light weight, for example
  `by *mass,* light`.
- Upload photos straight from the camera if you like: anything larger than 2400 px is
  scaled down automatically and phone photos are turned the right way up.
  JPG, PNG or WebP, up to 15 MB each.
- The **logo** should be black artwork on a transparent background (PNG). The site turns it
  white by itself in dark mode and on the dark loading bands.
- Every save makes a backup of the previous version first, so mistakes can be undone
  under Account & backups. Restoring brings back text and project data; images are never
  deleted by a restore.
- When you are signed in, every page of the website shows an **Edit in admin** button in
  the bottom-right corner.

---

## 3. Troubleshooting

| Problem | Fix |
| --- | --- |
| "500 Internal Server Error" on every page | Check the PHP version is 8.0+ (step 1.2). Make sure `.htaccess` was uploaded (Show Hidden Files). |
| Pages other than the home page show "404 Not Found" from the server | `.htaccess` is missing or was renamed; upload it again. |
| "The upload was larger than the server allows" | cPanel → Select PHP Version → **Options** → raise `upload_max_filesize` (16M) and `post_max_size` (64M), or upload fewer images per save. |
| "The data folder is not writable" | File Manager → right-click `data` and `uploads` → Change Permissions → 755. |
| Forgot the admin password | In File Manager delete `public_html/data/users.json`, then open `/admin` again: a new setup code is created and you set a new password. Content is not affected. |
| Locked out after several wrong passwords | Wait 15 minutes, or delete `data/throttle.json`. |
| Old addresses like `/archive.html` | They redirect automatically to the new clean addresses (`/works`, `/projects/…`). |

Error details are written to `data/error.log` (never visible to visitors).
For short-term debugging you can set `'debug' => true` in `app/config.php`.

---

## 4. Backing up the whole site
- Inside the admin panel: **Account & backups → Download current content**.
- Images: download the `public_html/uploads` folder from File Manager (right-click →
  Compress → download the zip) every now and then.
- Namecheap Stellar Plus / Business also include automatic daily backups (cPanel → Backup).

---

## 5. What is in the package

```
public_html/
├── index.php            Router for the public pages (/, /works, /projects/…, /studio, /contact, /sitemap.xml, /robots.txt)
├── .htaccess            Clean URLs, private folders, HTTPS switch, security headers, caching
├── .user.ini            PHP upload limits for the admin panel
├── favicon.svg
├── css/style.css        Website styles (light + dark mode)
├── js/                  main.js (splash, transitions, theme), home.js (horizontal track), archive.js (index)
├── images/              Starter images and logo
├── uploads/             Images uploaded from the admin panel (scripts blocked here)
├── admin/               The admin panel: index (projects), project, site, studio, contact, media,
│   │                    account, login, logout, setup
│   └── assets/          admin.css, admin.js
├── app/                 PHP code: never served directly (blocked by .htaccess)
│   ├── bootstrap.php, config.php
│   ├── lib/             helpers, store (content + backups), auth, media (uploads), view (page shell)
│   ├── admin/layout.php Admin page chrome and form fields
│   └── views/           home, works, project, studio, contact, 404
└── data/                content.json (all site text and projects), backups/, users.json (after setup):
                         never served directly
```

### Security built in
- Admin password stored only as a bcrypt hash; sign-in locks for 15 minutes after 5 failed attempts.
- First-run setup requires a one-time code readable only through your hosting account.
- Every admin form carries a CSRF token; sessions use HttpOnly, SameSite and (on HTTPS) Secure cookies, and expire after 2 hours idle.
- Uploads are checked by content (not by file name), renamed randomly, re-encoded when resized, and the uploads folder refuses to run scripts.
- `app/` and `data/` are blocked from the web; admin pages send `noindex`.

---

## 6. Previewing on your own computer (optional)
With PHP 8 installed:

```bash
cd namecheap
php -S localhost:8080 -t public_html dev-router.php
```
Then open http://localhost:8080 and http://localhost:8080/admin.
