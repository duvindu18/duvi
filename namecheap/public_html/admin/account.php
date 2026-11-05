<?php
/**
 * Password change, content download and backup restore.
 */
require __DIR__ . '/../app/bootstrap.php';
require APP_DIR . '/admin/layout.php';
require_admin();

if (($_GET['download'] ?? '') === 'content') {
    header('Content-Type: application/json; charset=utf-8');
    header('Content-Disposition: attachment; filename="content-' . date('Y-m-d') . '.json"');
    readfile(content_file());
    exit;
}

$pwError = null;
if (admin_post_guard()) {
    $action = post_str('action');
    if ($action === 'password') {
        $user = admin_user();
        $new = (string) ($_POST['new'] ?? '');
        if (!$user || !password_verify((string) ($_POST['current'] ?? ''), $user['hash'])) {
            flash('error', 'The current password is not right.');
        } elseif ($p = password_problem($new, (string) ($_POST['confirm'] ?? ''))) {
            flash('error', $p);
        } else {
            admin_save($user['username'], $new);
            session_regenerate_id(true);
            flash('ok', 'Password changed.');
        }
    } elseif ($action === 'restore') {
        try {
            backup_restore(post_str('file'));
            flash('ok', 'The site content was restored. The version you replaced was itself backed up first.');
        } catch (RuntimeException $ex) {
            flash('error', $ex->getMessage());
        }
    }
    redirect(url('admin/account.php'));
}

$user = admin_user();
$backups = backups_list();
admin_head('Account & backups', 'account'); ?>
<div class="adm-head"><div><h1>Account &amp; backups</h1></div></div>
<div class="editor__grid">
  <div class="editor__main">
    <section class="card">
      <h2>Backups</h2>
      <p class="hint">Every save keeps a copy of the previous version (the newest <?= (int) config('backups_keep', 40) ?> are kept). Restoring replaces all site text and project data with that version; images are not touched.</p>
      <?php if (!$backups): ?>
        <p class="hint">No backups yet. One is made automatically the first time you save.</p>
      <?php else: ?>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Saved</th><th>Made before</th><th class="r"></th></tr></thead>
        <tbody>
        <?php foreach ($backups as $b): ?>
          <tr>
            <td class="mono nowrap"><?= e(date('j M Y, H:i', $b['time'])) ?></td>
            <td><?= e($b['note']) ?></td>
            <td class="r"><form method="post" class="inline" data-confirm="Restore the version from <?= e(date('j M Y, H:i', $b['time'])) ?>? Current content is backed up first."><?= csrf_field() ?><input type="hidden" name="file" value="<?= e($b['file']) ?>"><button class="btn btn--small btn--ghost" name="action" value="restore" type="submit">Restore</button></form></td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table></div>
      <?php endif; ?>
      <p><a class="btn btn--ghost" href="<?= e(url('admin/account.php?download=content')) ?>">Download current content (.json)</a></p>
    </section>
  </div>
  <aside class="editor__side">
    <section class="card">
      <h2>Password</h2>
      <p class="hint">Signed in as <b><?= e($user['username'] ?? '') ?></b>.</p>
      <form method="post" class="stack">
        <?= csrf_field() ?>
        <input type="hidden" name="username" value="<?= e($user['username'] ?? '') ?>" autocomplete="username">
        <?= f_text('current', 'Current password', '', '', ['type' => 'password', 'autocomplete' => 'current-password', 'required' => true]) ?>
        <?= f_text('new', 'New password', '', 'At least 10 characters.', ['type' => 'password', 'autocomplete' => 'new-password', 'required' => true, 'minlength' => '10']) ?>
        <?= f_text('confirm', 'Repeat new password', '', '', ['type' => 'password', 'autocomplete' => 'new-password', 'required' => true]) ?>
        <button class="btn" name="action" value="password" type="submit">Change password</button>
      </form>
    </section>
    <section class="card">
      <h2>Server</h2>
      <dl class="facts">
        <dt>PHP</dt><dd><?= e(PHP_VERSION) ?></dd>
        <dt>Max upload</dt><dd><?= e(ini_get('upload_max_filesize')) ?> per file, <?= e(ini_get('post_max_size')) ?> per save</dd>
        <dt>Image resizing</dt><dd><?= extension_loaded('gd') ? 'On (GD)' : 'Off: GD extension missing' ?></dd>
        <dt>Data folder</dt><dd><?= is_writable(DATA_DIR) ? 'Writable' : '<b>Not writable</b>' ?></dd>
        <dt>Uploads folder</dt><dd><?= is_writable(UPLOADS_DIR) ? 'Writable' : '<b>Not writable</b>' ?></dd>
      </dl>
    </section>
  </aside>
</div>
<?php admin_foot();
