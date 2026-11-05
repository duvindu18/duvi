<?php
/**
 * Studio page: headline, introduction, principles, people, recognition, two images.
 */
require __DIR__ . '/../app/bootstrap.php';
require APP_DIR . '/admin/layout.php';
require_admin();

$c = content();

if (admin_post_guard()) {
    $errors = [];
    $s = $c['studio'];
    $s['headline'] = array_slice(lines(post_str('headline')), 0, 5);
    $s['paragraphs'] = paragraphs(post_str('paragraphs'));
    $s['principles'] = repeater_rows('principles', ['title', 'body'], 'title', ['title' => 80, 'body' => 400]);
    $s['people'] = repeater_rows('people', ['name', 'role'], 'name', ['name' => 80, 'role' => 80]);
    $s['recognition'] = repeater_rows('recognition', ['year', 'award', 'project'], 'award', ['year' => 10, 'award' => 160, 'project' => 120]);
    $figs = figures_from_post('figures', $errors);
    $s['figures'] = array_slice($figs, 0, 2);
    $s['show_people'] = !empty($_POST['show_people']);
    $s['show_recognition'] = !empty($_POST['show_recognition']);
    if (count($figs) > 2) {
        $errors[] = 'The Studio page shows two images; only the first two were kept. Extra uploads stay in Media.';
    }
    $c['studio'] = $s;
    try {
        content_save($c, 'Edit studio page');
        flash('ok', 'Studio page saved.');
    } catch (RuntimeException $ex) {
        $errors[] = $ex->getMessage();
    }
    foreach ($errors as $err) {
        flash('error', $err);
    }
    redirect(url('admin/studio.php'));
}

$s = $c['studio'];
admin_head('Studio page', 'studio'); ?>
<form method="post" enctype="multipart/form-data" class="editor" data-dirty-guard>
  <?= csrf_field() ?>
  <div class="adm-head">
    <div><h1>Studio page</h1></div>
    <div class="adm-head__actions"><a class="btn btn--ghost" href="<?= e(url('studio')) ?>" target="_blank" rel="noopener">View page ↗</a><button class="btn" type="submit">Save</button></div>
  </div>
  <div class="editor__grid editor__grid--single">
    <section class="card">
      <h2>Introduction</h2>
      <?= f_area('headline', 'Headline', implode("\n", $s['headline']), 'One line per row. *Asterisks* set a word in the light weight.', 3) ?>
      <?= f_area('paragraphs', 'Text', implode("\n\n", $s['paragraphs']), 'Leave an empty line between paragraphs. You can write <code>{founded}</code>, <code>{year}</code>, <code>{yy}</code> or <code>{experience}</code>: they are filled in automatically and update every year.', 6) ?>
    </section>
    <section class="card">
      <h2>Images</h2>
      <?= f_figures('figures', 'Studio images', $s['figures'], 'Two images: the first sits beside the principles, the second runs full width at the end of the page.') ?>
    </section>
    <section class="card"><?= f_repeater('principles', 'Principles', ['title' => ['Title', 'text', 'w-3'], 'body' => ['Text', 'textarea', 'w-7']], $s['principles'], 'Add principle', 'Numbered automatically in this order.') ?></section>
    <section class="card">
      <h2>Sections</h2>
      <label class="switch"><input type="checkbox" name="show_people" value="1"<?= !empty($s['show_people']) ? ' checked' : '' ?>><span class="switch__ui" aria-hidden="true"></span><span>Show People on the Studio page</span></label>
      <label class="switch"><input type="checkbox" name="show_recognition" value="1"<?= !empty($s['show_recognition']) ? ' checked' : '' ?>><span class="switch__ui" aria-hidden="true"></span><span>Show Recognition on the Studio page</span></label>
      <p class="hint">Hidden lists stay saved below, ready to switch back on.</p>
    </section>
    <section class="card"><?= f_repeater('people', 'People', ['name' => ['Name', 'text', 'w-5'], 'role' => ['Role', 'text', 'w-5']], $s['people'], 'Add person') ?></section>
    <section class="card"><?= f_repeater('recognition', 'Recognition', ['year' => ['Year', 'text', 'w-1'], 'award' => ['Award', 'text', 'w-5'], 'project' => ['Project', 'text', 'w-4']], $s['recognition'], 'Add award') ?></section>
  </div>
</form>
<?php admin_foot();
