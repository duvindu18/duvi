<?php
/**
 * First run: create the admin account. Needs the one-time code stored in
 * data/setup-code.txt (readable only through cPanel File Manager / FTP).
 */
require __DIR__ . '/../app/bootstrap.php';
require APP_DIR . '/admin/layout.php';
session_boot();

if (admin_exists()) {
    redirect(url('admin/login.php'));
}

$code = setup_code();
$error = null;
$username = 'admin';

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    csrf_check();
    $username = mb_substr(post_str('username'), 0, 60);
    $password = (string) ($_POST['password'] ?? '');
    $confirm = (string) ($_POST['confirm'] ?? '');
    if (throttle_locked()) {
        $error = 'Too many attempts. Try again in ' . throttle_locked() . ' minutes.';
    } elseif (!hash_equals($code, strtoupper(trim(post_str('code'))))) {
        throttle_fail();
        $error = 'That setup code is not right. Open data/setup-code.txt in cPanel File Manager and copy it exactly.';
    } elseif (!preg_match('/^[\w.@-]{3,60}$/u', $username)) {
        $error = 'Choose a user name of 3 to 60 letters, numbers, dots, dashes or @.';
    } elseif ($p = password_problem($password, $confirm)) {
        $error = $p;
    } else {
        try {
            admin_save($username, $password);
            setup_done();
            login_attempt($username, $password);
            flash('ok', 'Your admin account is ready. Welcome.');
            redirect(url('admin/'));
        } catch (RuntimeException $ex) {
            $error = $ex->getMessage();
        }
    }
}

admin_head('Set up', '', false); ?>
<div class="auth">
  <img class="auth__logo" src="<?= e(url(content()['site']['logo']['src'])) ?>" alt="<?= e(content()['site']['name']) ?>">
  <h1>Create the admin account</h1>
  <p class="hint">This page works only once. For security it asks for the setup code that was just written to
     <code>data/setup-code.txt</code> on your hosting. In cPanel open <b>File Manager → public_html → data</b>, open that file and copy the code.</p>
  <?php if ($error): ?><div class="adm-flash adm-flash--error" role="alert"><?= e($error) ?></div><?php endif; ?>
  <form method="post" class="stack">
    <?= csrf_field() ?>
    <?= f_text('code', 'Setup code', '', '', ['autocomplete' => 'off', 'required' => true, 'autocapitalize' => 'characters']) ?>
    <?= f_text('username', 'User name', $username, '', ['autocomplete' => 'username', 'required' => true]) ?>
    <?= f_text('password', 'Password', '', 'At least 10 characters. A short sentence is easy to remember and hard to guess.', ['type' => 'password', 'autocomplete' => 'new-password', 'required' => true, 'minlength' => '10']) ?>
    <?= f_text('confirm', 'Repeat password', '', '', ['type' => 'password', 'autocomplete' => 'new-password', 'required' => true]) ?>
    <button class="btn" type="submit">Create account</button>
  </form>
</div>
<?php admin_foot();
