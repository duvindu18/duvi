<?php
/**
 * Uploaded images: see where each one is used, delete unused files.
 */
require __DIR__ . '/../app/bootstrap.php';
require APP_DIR . '/admin/layout.php';
require_admin();

if (admin_post_guard()) {
    $usage = media_usage(content());
    $targets = post_str('action') === 'delete-unused'
        ? array_column(array_filter(uploads_all(), function ($f) use ($usage) { return empty($usage[$f['src']]); }), 'src')
        : [post_str('src')];
    $deleted = 0;
    foreach ($targets as $src) {
        if (!empty($usage[$src])) {
            flash('error', basename($src) . ' is still used by: ' . implode(', ', $usage[$src]) . '. Remove it there first.');
            continue;
        }
        try {
            upload_delete($src);
            $deleted++;
        } catch (RuntimeException $ex) {
            flash('error', $ex->getMessage());
        }
    }
    if ($deleted) {
        flash('ok', $deleted . ' image' . ($deleted === 1 ? '' : 's') . ' deleted.');
    }
    redirect(url('admin/media.php'));
}

$files = uploads_all();
$usage = media_usage(content());
$unused = count(array_filter($files, function ($f) use ($usage) { return empty($usage[$f['src']]); }));
$total = array_sum(array_column($files, 'size'));

admin_head('Media', 'media'); ?>
<div class="adm-head">
  <div>
    <h1>Media</h1>
    <p class="hint"><?= count($files) ?> uploaded image<?= count($files) === 1 ? '' : 's' ?> · <?= number_format($total / 1048576, 1) ?> MB · <?= $unused ?> not used anywhere. Upload images from a project, the Studio page or the logo setting.</p>
  </div>
  <?php if ($unused): ?>
  <form method="post" data-confirm="Delete all <?= $unused ?> unused images? This cannot be undone."><?= csrf_field() ?>
    <button class="btn btn--danger" name="action" value="delete-unused" type="submit">Delete unused (<?= $unused ?>)</button>
  </form>
  <?php endif; ?>
</div>

<?php if (!$files): ?>
  <div class="empty"><h2>No uploads yet</h2><p>Images you add to projects appear here. The starter images that came with the site live in the <code>images</code> folder and are not listed.</p></div>
<?php else: ?>
<ul class="media-grid">
  <?php foreach ($files as $f): $used = $usage[$f['src']] ?? []; ?>
  <li class="media-item<?= $used ? '' : ' is-unused' ?>">
    <a href="<?= e(url($f['src'])) ?>" target="_blank" rel="noopener"><img src="<?= e(url($f['src'])) ?>" alt="" loading="lazy"></a>
    <div class="media-item__meta">
      <p class="mono small-text" title="<?= e($f['src']) ?>"><?= e(basename($f['src'])) ?></p>
      <p class="hint"><?= number_format($f['size'] / 1024) ?> KB · <?= e(date('j M Y', $f['time'])) ?></p>
      <p class="hint"><?= $used ? 'Used in: ' . e(implode(', ', array_unique($used))) : '<b>Not used</b>' ?></p>
      <?php if (!$used): ?>
      <form method="post" data-confirm="Delete <?= e(basename($f['src'])) ?>?"><?= csrf_field() ?><input type="hidden" name="src" value="<?= e($f['src']) ?>">
        <button class="link-btn link-btn--danger" name="action" value="delete" type="submit">Delete</button>
      </form>
      <?php endif; ?>
    </div>
  </li>
  <?php endforeach; ?>
</ul>
<?php endif;
admin_foot();
