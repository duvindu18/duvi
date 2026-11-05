<?php
/**
 * Create or edit a project.
 */
require __DIR__ . '/../app/bootstrap.php';
require APP_DIR . '/admin/layout.php';
require_admin();

$c = content();
$id = (string) ($_GET['id'] ?? '');
$existing = $id !== '' ? find_project('id', $id) : null;
if ($id !== '' && !$existing) {
    flash('error', 'That project no longer exists.');
    redirect(url('admin/'));
}
$p = $existing ?: normalize_project(['title' => '', 'slug' => '', 'published' => false]);
$errors = [];

if (admin_post_guard()) {
    $title = mb_substr(post_str('title'), 0, 120);
    $slug = slugify(post_str('slug') !== '' ? post_str('slug') : $title);
    $year = (int) post_str('year');
    $status = in_array(post_str('status'), PROJECT_STATUSES, true) ? post_str('status') : 'Completed';

    if ($title === '') {
        $errors[] = 'Give the project a title.';
    }
    if ($year < 1800 || $year > 2200) {
        $errors[] = 'Enter the year as four digits, for example ' . date('Y') . '.';
    }
    foreach ($c['projects'] as $other) {
        if ($other['slug'] === $slug && $other['id'] !== $p['id']) {
            $errors[] = 'Another project already uses the web address "' . $slug . '". Change the title or the web address.';
        }
    }

    $materials = repeater_rows('materials', ['name', 'note', 'swatch'], 'name', ['name' => 80, 'note' => 120]);
    foreach ($materials as &$m) {
        if (!is_hex_color($m['swatch'])) {
            $m['swatch'] = '#cccccc';
        }
    }
    unset($m);

    // Keep what was typed even if there are errors.
    $p = array_merge($p, [
        'title' => $title, 'slug' => $slug, 'typology' => mb_substr(post_str('typology'), 0, 80),
        'city' => mb_substr(post_str('city'), 0, 80), 'country' => mb_substr(post_str('country'), 0, 80),
        'year' => $year ?: (int) date('Y'), 'status' => $status, 'area' => mb_substr(post_str('area'), 0, 40),
        'client' => mb_substr(post_str('client'), 0, 120), 'team' => mb_substr(post_str('team'), 0, 300),
        'lead' => mb_substr(post_str('lead'), 0, 400), 'narrative' => paragraphs(post_str('narrative')),
        'materials' => $materials,
    ]);

    if (!$errors) {
        $uploadErrors = [];
        $p['figures'] = figures_from_post('figures', $uploadErrors);
        $wantPublish = !empty($_POST['published']);
        if ($wantPublish && !$p['figures']) {
            $wantPublish = false;
            $uploadErrors[] = 'The project was saved as a draft: add at least one image before publishing.';
        }
        $p['published'] = $wantPublish;
        $p['updated'] = date('c');

        if ($existing) {
            $c['projects'][$existing['_pos']] = $p;
        } else {
            // New projects go first so they lead the home page; reorder from the list.
            array_unshift($c['projects'], $p);
        }
        unset($p['_pos']);
        foreach ($c['projects'] as &$pp) {
            unset($pp['_pos']);
        }
        unset($pp);

        try {
            content_save($c, ($existing ? 'Edit ' : 'Create ') . $title);
            foreach ($uploadErrors as $ue) {
                flash('error', $ue);
            }
            flash('ok', '"' . $title . '" was saved' . ($p['published'] ? ' and is live on the website.' : ' as a draft.'));
            redirect(url('admin/project.php?id=' . rawurlencode($p['id'])));
        } catch (RuntimeException $ex) {
            $errors[] = $ex->getMessage();
        }
    }
}

$isNew = !$existing;
admin_head($isNew ? 'New project' : $p['title'], 'projects'); ?>
<form method="post" enctype="multipart/form-data" class="editor" data-dirty-guard>
  <?= csrf_field() ?>
  <div class="adm-head">
    <div>
      <p class="crumb"><a href="<?= e(url('admin/')) ?>">Projects</a> /</p>
      <h1><?= $isNew ? 'New project' : e($p['title']) ?></h1>
    </div>
    <div class="adm-head__actions">
      <?php if (!$isNew): ?><a class="btn btn--ghost" href="<?= e(url('projects/' . rawurlencode($p['slug']))) ?>" target="_blank" rel="noopener"><?= $p['published'] ? 'View on site ↗' : 'Preview draft ↗' ?></a><?php endif; ?>
      <button class="btn" type="submit">Save</button>
    </div>
  </div>

  <?php foreach ($errors as $err): ?><div class="adm-flash adm-flash--error" role="alert"><?= e($err) ?></div><?php endforeach; ?>

  <div class="editor__grid">
    <div class="editor__main">
      <section class="card">
        <h2>Basics</h2>
        <?= f_text('title', 'Title', $p['title'], '', ['required' => true, 'maxlength' => '120', 'data-slug-source' => true]) ?>
        <?= f_text('slug', 'Web address', $p['slug'], 'Shown as <code>' . e(abs_url('projects/')) . '<b data-slug-preview>' . e($p['slug']) . '</b></code>. Leave empty to build it from the title.', ['pattern' => '[a-z0-9-]*', 'data-slug-target' => true]) ?>
        <?= f_area('lead', 'Short description', $p['lead'], 'One or two sentences. Shown under the title and in search results and link previews.', 2, ['maxlength' => '400']) ?>
        <div class="row3">
          <?= f_text('typology', 'Type', $p['typology'], 'For example: Private Residence', ['list' => 'typologies']) ?>
          <?= f_text('year', 'Year', $p['year'], '', ['type' => 'number', 'min' => '1800', 'max' => '2200', 'required' => true]) ?>
          <?= f_select('status', 'Status', $p['status'], PROJECT_STATUSES) ?>
        </div>
        <datalist id="typologies"><?php foreach (array_unique(array_column($c['projects'], 'typology')) as $t): ?><option value="<?= e($t) ?>"><?php endforeach; ?></datalist>
        <div class="row3">
          <?= f_text('city', 'City / region', $p['city']) ?>
          <?= f_text('country', 'Country', $p['country']) ?>
          <?= f_text('area', 'Area', $p['area'], 'For example: 412 m²') ?>
        </div>
        <div class="row2">
          <?= f_text('client', 'Client', $p['client']) ?>
          <?= f_text('team', 'Team', $p['team'], 'Shown as the credit in the book spread.') ?>
        </div>
      </section>

      <section class="card">
        <h2>Images</h2>
        <?= f_figures('figures', 'Project images', $p['figures'], 'The first image is the cover (home page, index preview, link previews). The second and third also appear in the printed book spread. Use ↑ ↓ to reorder.') ?>
      </section>

      <section class="card">
        <h2>Text</h2>
        <?= f_area('narrative', 'Project text', implode("\n\n", $p['narrative']), 'Leave an empty line between paragraphs. Shown in the book spread on the project page.', 10) ?>
      </section>

      <section class="card">
        <?= f_repeater('materials', 'Materials', ['name' => ['Material', 'text', 'w-4'], 'note' => ['Note', 'text', 'w-5'], 'swatch' => ['Colour', 'color', 'w-1']], $p['materials'], 'Add material', 'Listed under the project facts, each with a colour dot.') ?>
      </section>
    </div>

    <aside class="editor__side">
      <section class="card card--sticky">
        <h2>Publishing</h2>
        <label class="switch">
          <input type="checkbox" name="published" value="1"<?= $p['published'] ? ' checked' : '' ?>>
          <span class="switch__ui" aria-hidden="true"></span>
          <span>Published on the website</span>
        </label>
        <p class="hint">Drafts are hidden from visitors. While signed in you can still preview them.</p>
        <?php if (!empty($p['updated'])): ?><p class="hint">Last saved <?= e(date('j M Y, H:i', strtotime($p['updated']))) ?></p><?php endif; ?>
        <button class="btn btn--block" type="submit">Save</button>
      </section>
    </aside>
  </div>
</form>
<?php admin_foot();
