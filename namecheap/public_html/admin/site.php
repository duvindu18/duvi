<?php
/**
 * Site identity, contact details, home page and index page texts, social links, logo.
 */
require __DIR__ . '/../app/bootstrap.php';
require APP_DIR . '/admin/layout.php';
require_admin();

$c = content();
$errors = [];

if (admin_post_guard()) {
    $site = $c['site'];
    $site['name'] = mb_substr(post_str('name'), 0, 80) ?: $site['name'];
    $site['descriptor'] = mb_substr(post_str('descriptor'), 0, 60);
    $site['tagline'] = mb_substr(post_str('tagline'), 0, 160);
    $site['description'] = mb_substr(post_str('description'), 0, 300);
    $site['founded'] = mb_substr(post_str('founded'), 0, 10);
    $email = post_str('email');
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $errors[] = '"' . $email . '" does not look like an email address, so the previous one was kept.';
    } else {
        $site['email'] = $email;
    }
    $site['phone'] = mb_substr(post_str('phone'), 0, 40);

    $social = [];
    foreach (repeater_rows('social', ['label', 'short', 'url'], 'url', ['label' => 40, 'short' => 6, 'url' => 300]) as $s) {
        if (!preg_match('#^https?://[^\s]+$#i', $s['url'])) {
            $errors[] = 'The link "' . $s['url'] . '" was skipped: links must start with https://';
            continue;
        }
        $social[] = $s;
    }
    foreach ($social as $i => $s) {
        if ($s['short'] === '') {
            $social[$i]['short'] = mb_strtoupper(mb_substr($s['label'] ?: 'Link', 0, 2));
        }
        if ($s['label'] === '') {
            $social[$i]['label'] = parse_url($s['url'], PHP_URL_HOST) ?: 'Link';
        }
    }
    $site['social'] = $social;
    $site['show_client'] = !empty($_POST['show_client']);
    $site['show_materials'] = !empty($_POST['show_materials']);

    $logoFiles = files_list('logo_new');
    if ($logoFiles) {
        try {
            $img = store_image($logoFiles[0], true);
            if (substr($img['src'], -4) === '.jpg') {
                $errors[] = 'The logo was uploaded as a JPG, which has no transparent background. A PNG with a transparent background works best.';
            }
            $site['logo'] = $img;
        } catch (RuntimeException $ex) {
            $errors[] = $ex->getMessage();
        }
    }

    $home = $c['home'];
    $home['kicker'] = mb_substr(post_str('kicker'), 0, 80);
    $home['headline'] = array_slice(lines(post_str('headline')), 0, 5);
    $home['practice_label'] = mb_substr(post_str('practice_label'), 0, 30);
    $home['practice'] = mb_substr(post_str('practice'), 0, 120);
    $home['chapter_word'] = mb_substr(post_str('chapter_word'), 0, 20);
    $home['chapter_number'] = mb_substr(post_str('chapter_number'), 0, 10);
    $home['chapter_text'] = mb_substr(post_str('chapter_text'), 0, 300);
    $home['marquee'] = mb_substr(post_str('marquee'), 0, 200);
    $home['end_text'] = mb_substr(post_str('end_text'), 0, 300);

    $c['site'] = $site;
    $c['home'] = $home;
    $c['works']['intro'] = mb_substr(post_str('works_intro'), 0, 300);

    // Valid changes are always saved; problems are reported alongside.
    try {
        content_save($c, 'Edit site settings');
        flash('ok', 'Site settings saved.');
    } catch (RuntimeException $ex) {
        $errors[] = $ex->getMessage();
    }
    foreach ($errors as $err) {
        flash('error', $err);
    }
    redirect(url('admin/site.php'));
}

$site = $c['site'];
$home = $c['home'];
admin_head('Site & home', 'site'); ?>
<form method="post" enctype="multipart/form-data" class="editor" data-dirty-guard>
  <?= csrf_field() ?>
  <div class="adm-head">
    <div><h1>Site &amp; home page</h1><p class="hint">Studio details used on every page, plus the texts of the home and index pages.</p></div>
    <div class="adm-head__actions"><a class="btn btn--ghost" href="<?= e(url()) ?>" target="_blank" rel="noopener">View home ↗</a><button class="btn" type="submit">Save</button></div>
  </div>

  <div class="editor__grid editor__grid--single">
    <section class="card">
      <h2>Studio</h2>
      <div class="row2">
        <?= f_text('name', 'Studio name', $site['name'], 'Used in page titles and link previews.', ['required' => true]) ?>
        <?= f_text('descriptor', 'Descriptor', $site['descriptor'], 'Small line under the logo, e.g. Architecture Office.') ?>
      </div>
      <?= f_text('tagline', 'Tagline', $site['tagline'], 'Shown on the loading screen.') ?>
      <?= f_area('description', 'Short description', $site['description'], 'Shown on the home page and used by search engines.', 2) ?>
      <div class="row3">
        <?= f_text('founded', 'Founded (year)', $site['founded'], 'Years of experience are counted from this year.') ?>
        <?= f_text('email', 'Email', $site['email'], '', ['type' => 'email']) ?>
        <?= f_text('phone', 'Phone', $site['phone']) ?>
      </div>
    </section>

    <section class="card">
      <h2>Project pages</h2>
      <p class="hint">Choose which optional facts appear on project pages. The information stays saved in each project either way, so you can switch it back on at any time.</p>
      <label class="switch"><input type="checkbox" name="show_client" value="1"<?= !empty($site['show_client']) ? ' checked' : '' ?>><span class="switch__ui" aria-hidden="true"></span><span>Show client</span></label>
      <label class="switch"><input type="checkbox" name="show_materials" value="1"<?= !empty($site['show_materials']) ? ' checked' : '' ?>><span class="switch__ui" aria-hidden="true"></span><span>Show materials</span></label>
    </section>

    <section class="card">
      <h2>Logo</h2>
      <div class="logo-preview">
        <div class="logo-preview__light"><img src="<?= e(url($site['logo']['src'])) ?>" alt="Current logo on light"></div>
        <div class="logo-preview__dark"><img src="<?= e(url($site['logo']['src'])) ?>" alt="Current logo on dark"></div>
      </div>
      <label class="drop"><input type="file" name="logo_new" accept="image/png,image/webp" data-file-preview>
        <span><b>Replace logo</b> — a black logo on a transparent background (PNG). The site turns it white automatically in dark mode and on the dark loading bands.</span></label>
      <div class="drop-preview" data-preview></div>
    </section>

    <section class="card">
      <h2>Home page</h2>
      <p class="hint">You can write <code>{founded}</code>, <code>{year}</code>, <code>{yy}</code> or <code>{experience}</code>: they are filled in automatically and update every year.</p>
      <?= f_text('kicker', 'Small heading', $home['kicker'], 'Above the big headline, and on the loading screen.') ?>
      <?= f_area('headline', 'Headline', implode("\n", $home['headline']), 'One line per row. Wrap words in *asterisks* to set them in the light weight, e.g. <code>by *mass,* light</code>.', 3) ?>
      <div class="row2">
        <?= f_text('practice_label', 'Facts heading', $home['practice_label'], 'e.g. Services or Practice.') ?>
        <?= f_text('practice', 'Facts', $home['practice'], 'Short list beside the description, e.g. Stills, film, interactive tours.') ?>
      </div>
      <div class="row3">
        <?= f_text('chapter_word', 'Chapter word', $home['chapter_word'], 'The very large word, e.g. Works.') ?>
        <?= f_text('chapter_number', 'Chapter number', $home['chapter_number'], 'e.g. /26') ?>
        <?= f_text('marquee', 'Scrolling line', $home['marquee'], 'Runs across the top of the chapter panel.') ?>
      </div>
      <?= f_area('chapter_text', 'Chapter text', $home['chapter_text'], '', 2) ?>
      <?= f_area('end_text', 'Closing text', $home['end_text'], 'Under “The full index” at the end of the home page.', 2) ?>
    </section>

    <section class="card">
      <h2>Index page</h2>
      <?= f_area('works_intro', 'Introduction', $c['works']['intro'], '', 2) ?>
    </section>

    <section class="card">
      <?= f_repeater('social', 'Social links', ['label' => ['Name', 'text', 'w-3'], 'short' => ['Short', 'text', 'w-1'], 'url' => ['Address (https://…)', 'url', 'w-6']], $site['social'], 'Add link', 'The short form (2 letters) is shown in the side column; the full name on the Contact page.') ?>
    </section>
  </div>
</form>
<?php admin_foot();
