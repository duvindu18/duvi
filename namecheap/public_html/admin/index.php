<?php
/**
 * Projects dashboard: publish / unpublish, reorder, delete, create.
 */
require __DIR__ . '/../app/bootstrap.php';
require APP_DIR . '/admin/layout.php';
require_admin();

if (admin_post_guard()) {
    $c = content();
    $id = post_str('id');
    $action = post_str('action');
    $pos = null;
    foreach ($c['projects'] as $i => $p) {
        if ($p['id'] === $id) {
            $pos = $i;
        }
    }
    if ($pos === null) {
        flash('error', 'That project no longer exists.');
        redirect(url('admin/'));
    }
    $p = $c['projects'][$pos];
    try {
        switch ($action) {
            case 'publish':
                if (!$p['figures']) {
                    throw new RuntimeException('Add at least one image to "' . $p['title'] . '" before publishing it.');
                }
                $c['projects'][$pos]['published'] = true;
                content_save($c, 'Publish ' . $p['title']);
                flash('ok', '"' . $p['title'] . '" is now live on the website.');
                break;
            case 'unpublish':
                $c['projects'][$pos]['published'] = false;
                content_save($c, 'Unpublish ' . $p['title']);
                flash('ok', '"' . $p['title'] . '" is now a draft and hidden from visitors.');
                break;
            case 'up':
            case 'down':
                $to = $action === 'up' ? $pos - 1 : $pos + 1;
                if ($to >= 0 && $to < count($c['projects'])) {
                    [$c['projects'][$pos], $c['projects'][$to]] = [$c['projects'][$to], $c['projects'][$pos]];
                    content_save($c, 'Reorder projects');
                }
                break;
            case 'delete':
                array_splice($c['projects'], $pos, 1);
                content_save($c, 'Delete ' . $p['title']);
                flash('ok', '"' . $p['title'] . '" was deleted. Its images stay in Media until you remove them; a backup was saved under Account & backups.');
                break;
        }
    } catch (RuntimeException $ex) {
        flash('error', $ex->getMessage());
    }
    redirect(url('admin/'));
}

$c = content();
$live = count(published_projects());
$drafts = count($c['projects']) - $live;
$n = 0;

admin_head('Projects', 'projects'); ?>
<div class="adm-head">
  <div>
    <h1>Projects</h1>
    <p class="hint"><?= $live ?> published · <?= $drafts ?> draft<?= $drafts === 1 ? '' : 's' ?>. The order here is the order on the website; numbers are given to published projects only.</p>
  </div>
  <a class="btn" href="<?= e(url('admin/project.php')) ?>">+ New project</a>
</div>

<?php if (!$c['projects']): ?>
  <div class="empty">
    <h2>No projects yet</h2>
    <p>Create your first project, add its photographs and publish it when it is ready.</p>
    <a class="btn" href="<?= e(url('admin/project.php')) ?>">+ New project</a>
  </div>
<?php else: ?>
<div class="tbl-wrap">
<table class="tbl">
  <thead><tr><th>No.</th><th></th><th>Project</th><th>Year</th><th>Status</th><th>Visibility</th><th class="r">Actions</th></tr></thead>
  <tbody>
  <?php foreach ($c['projects'] as $i => $p): $cv = cover($p); $pub = !empty($p['published']); ?>
    <tr class="<?= $pub ? '' : 'is-draft' ?>">
      <td class="mono"><?= $pub ? pad2(++$n) : '—' ?></td>
      <td><?php if ($cv): ?><img class="thumb" src="<?= e(url($cv['src'])) ?>" alt="" loading="lazy"><?php else: ?><span class="thumb thumb--empty">No image</span><?php endif; ?></td>
      <td>
        <a class="tbl-title" href="<?= e(url('admin/project.php?id=' . rawurlencode($p['id']))) ?>"><?= e($p['title']) ?></a>
        <div class="hint"><?= e(trim($p['typology'] . ' · ' . $p['city'] . ', ' . $p['country'], ' ·,')) ?></div>
      </td>
      <td class="mono"><?= e($p['year']) ?></td>
      <td><?= e($p['status']) ?></td>
      <td>
        <form method="post" class="inline"><?= csrf_field() ?><input type="hidden" name="id" value="<?= e($p['id']) ?>">
          <?php if ($pub): ?>
            <span class="pill pill--live">Published</span>
            <button class="link-btn" name="action" value="unpublish" type="submit">Unpublish</button>
          <?php else: ?>
            <span class="pill">Draft</span>
            <button class="link-btn" name="action" value="publish" type="submit">Publish</button>
          <?php endif; ?>
        </form>
      </td>
      <td class="r nowrap">
        <form method="post" class="inline"><?= csrf_field() ?><input type="hidden" name="id" value="<?= e($p['id']) ?>">
          <button class="icon-btn" name="action" value="up" type="submit" aria-label="Move up"<?= $i === 0 ? ' disabled' : '' ?>>↑</button>
          <button class="icon-btn" name="action" value="down" type="submit" aria-label="Move down"<?= $i === count($c['projects']) - 1 ? ' disabled' : '' ?>>↓</button>
        </form>
        <a class="btn btn--small btn--ghost" href="<?= e(url('admin/project.php?id=' . rawurlencode($p['id']))) ?>">Edit</a>
        <a class="btn btn--small btn--ghost" href="<?= e(url('projects/' . rawurlencode($p['slug']))) ?>" target="_blank" rel="noopener"><?= $pub ? 'View' : 'Preview' ?></a>
        <form method="post" class="inline" data-confirm="Delete “<?= e($p['title']) ?>”? This cannot be undone from here, but a backup is kept under Account & backups."><?= csrf_field() ?><input type="hidden" name="id" value="<?= e($p['id']) ?>">
          <button class="btn btn--small btn--danger" name="action" value="delete" type="submit">Delete</button>
        </form>
      </td>
    </tr>
  <?php endforeach; ?>
  </tbody>
</table>
</div>
<?php endif;
admin_foot();
