<?php
require __DIR__ . '/../app/bootstrap.php';
require APP_DIR . '/admin/layout.php';
session_boot();

if (!admin_exists()) {
    redirect(url('admin/setup.php'));
}
if (is_admin()) {
    redirect(url('admin/'));
}

$error = null;
$username = '';
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    csrf_check();
    $username = mb_substr(post_str('username'), 0, 60);
    if ($mins = throttle_locked()) {
        $error = "Too many failed attempts. Try again in $mins minute" . ($mins === 1 ? '' : 's') . '.';
    } elseif (login_attempt($username, (string) ($_POST['password'] ?? ''))) {
        redirect(url('admin/'));
    } else {
        $error = 'The user name or password is not right.';
        usleep(400000);
    }
}

admin_head('Sign in', '', false); ?>
<div class="auth">
  <img class="auth__logo" src="<?= e(url(content()['site']['logo']['src'])) ?>" alt="<?= e(content()['site']['name']) ?>">
  <h1>Sign in</h1>
  <?php if ($error): ?><div class="adm-flash adm-flash--error" role="alert"><?= e($error) ?></div><?php endif; ?>
  <form method="post" class="stack">
    <?= csrf_field() ?>
    <?= f_text('username', 'User name', $username, '', ['autocomplete' => 'username', 'required' => true, 'autofocus' => true]) ?>
    <?= f_text('password', 'Password', '', '', ['type' => 'password', 'autocomplete' => 'current-password', 'required' => true]) ?>
    <button class="btn" type="submit">Sign in</button>
  </form>
  <p class="hint"><a href="<?= e(url()) ?>">← Back to the website</a></p>
</div>
<?php admin_foot();
