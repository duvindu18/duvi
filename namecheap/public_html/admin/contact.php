<?php
/**
 * Contact page: headline, introduction and extra contact addresses.
 */
require __DIR__ . '/../app/bootstrap.php';
require APP_DIR . '/admin/layout.php';
require_admin();

$c = content();

if (admin_post_guard()) {
    $errors = [];
    $ct = $c['contact'];
    $ct['headline'] = array_slice(lines(post_str('headline')), 0, 4);
    $ct['intro'] = mb_substr(post_str('intro'), 0, 600);
    $ct['based_note'] = mb_substr(post_str('based_note'), 0, 200);
    $ct['contacts'] = repeater_rows('contacts', ['label', 'email', 'note'], 'email', ['label' => 40, 'email' => 120, 'note' => 200]);
    foreach ($ct['contacts'] as $x) {
        if (!filter_var($x['email'], FILTER_VALIDATE_EMAIL)) {
            $errors[] = '"' . $x['email'] . '" does not look like an email address. It was saved anyway; check it.';
        }
    }
    $c['contact'] = $ct;
    try {
        content_save($c, 'Edit contact page');
        flash('ok', 'Contact page saved.');
    } catch (RuntimeException $ex) {
        $errors[] = $ex->getMessage();
    }
    foreach ($errors as $err) {
        flash('error', $err);
    }
    redirect(url('admin/contact.php'));
}

$ct = $c['contact'];
admin_head('Contact page', 'contact'); ?>
<form method="post" class="editor" data-dirty-guard>
  <?= csrf_field() ?>
  <div class="adm-head">
    <div><h1>Contact page</h1><p class="hint">The main email and phone number are set under <a href="<?= e(url('admin/site.php')) ?>">Site &amp; home</a>.</p></div>
    <div class="adm-head__actions"><a class="btn btn--ghost" href="<?= e(url('contact')) ?>" target="_blank" rel="noopener">View page ↗</a><button class="btn" type="submit">Save</button></div>
  </div>
  <div class="editor__grid editor__grid--single">
    <section class="card">
      <?= f_area('headline', 'Headline', implode("\n", $ct['headline']), 'One line per row. *Asterisks* set words in the light weight.', 2) ?>
      <?= f_area('intro', 'Text under the email', $ct['intro'], '', 3) ?>
      <?= f_text('based_note', 'Note under the studio location', $ct['based_note'], 'The location itself is set under Site &amp; home → Based in.') ?>
    </section>
    <section class="card"><?= f_repeater('contacts', 'Other contacts', ['label' => ['Heading', 'text', 'w-2'], 'email' => ['Email', 'email', 'w-4'], 'note' => ['Note', 'text', 'w-4']], $ct['contacts'], 'Add contact', 'For example Press or Careers. Shown beside the main email.') ?></section>
  </div>
</form>
<?php admin_foot();
