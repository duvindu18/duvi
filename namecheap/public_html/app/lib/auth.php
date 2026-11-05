<?php
/**
 * Admin account, sign-in, brute-force throttling and first-run setup.
 */
defined('MORFIS') || exit;

function users_file(): string
{
    return DATA_DIR . '/users.json';
}

function admin_exists(): bool
{
    return is_file(users_file());
}

function admin_user(): ?array
{
    if (!admin_exists()) {
        return null;
    }
    $u = json_decode((string) file_get_contents(users_file()), true);
    return is_array($u) && !empty($u['username']) && !empty($u['hash']) ? $u : null;
}

function admin_save(string $username, string $password): void
{
    $data = [
        'username' => $username,
        'hash'     => password_hash($password, PASSWORD_DEFAULT),
        'changed'  => date('c'),
    ];
    if (file_put_contents(users_file(), json_encode($data, JSON_PRETTY_PRINT), LOCK_EX) === false) {
        throw new RuntimeException('Could not save the account. Check that the data folder is writable.');
    }
    @chmod(users_file(), 0600);
}

function password_problem(string $password, string $confirm): ?string
{
    if (mb_strlen($password) < 10) {
        return 'Use at least 10 characters for the password.';
    }
    if ($password !== $confirm) {
        return 'The two passwords do not match.';
    }
    return null;
}

/* -------------------------------------------------------------- Sessions */

/** Is the current visitor a signed-in admin? Safe to call from public pages. */
function is_admin(): bool
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        if (empty($_COOKIE['morfis_admin'])) {
            return false; // never start sessions for ordinary visitors
        }
        session_boot(true);
    }
    $idle = (int) config('session_idle_minutes', 120) * 60;
    return !empty($_SESSION['admin']) && (time() - (int) ($_SESSION['seen'] ?? 0)) < $idle;
}

/** Gate for every admin page. */
function require_admin(): void
{
    session_boot();
    if (!admin_exists()) {
        redirect(url('admin/setup.php'));
    }
    if (!is_admin()) {
        $_SESSION = [];
        redirect(url('admin/login.php'));
    }
    $_SESSION['seen'] = time();
    header('X-Robots-Tag: noindex, nofollow');
    header('Cache-Control: no-store');
}

function login_attempt(string $username, string $password): bool
{
    $user = admin_user();
    $ok = $user
        && hash_equals(mb_strtolower($user['username']), mb_strtolower($username))
        && password_verify($password, $user['hash']);
    if ($ok) {
        if (password_needs_rehash($user['hash'], PASSWORD_DEFAULT)) {
            admin_save($user['username'], $password);
        }
        session_regenerate_id(true);
        $_SESSION['admin'] = $user['username'];
        $_SESSION['seen'] = time();
        throttle_clear();
    } else {
        throttle_fail();
    }
    return (bool) $ok;
}

function logout(): void
{
    session_boot();
    $_SESSION = [];
    $p = session_get_cookie_params();
    setcookie(session_name(), '', time() - 3600, $p['path'], '', $p['secure'], true);
    session_destroy();
}

/* ------------------------------------------------------------- Throttle */

function throttle_file(): string
{
    return DATA_DIR . '/throttle.json';
}

function throttle_key(): string
{
    return hash('sha256', $_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

function throttle_read(): array
{
    $d = is_file(throttle_file()) ? json_decode((string) file_get_contents(throttle_file()), true) : [];
    return is_array($d) ? $d : [];
}

function throttle_write(array $d): void
{
    $now = time();
    $d = array_filter($d, function ($r) use ($now) {
        return ($r['until'] ?? 0) > $now || ($r['last'] ?? 0) > $now - 86400;
    });
    @file_put_contents(throttle_file(), json_encode($d), LOCK_EX);
}

/** Minutes left on a lock-out, or 0. */
function throttle_locked(): int
{
    $r = throttle_read()[throttle_key()] ?? null;
    $left = $r ? (int) ($r['until'] ?? 0) - time() : 0;
    return $left > 0 ? (int) ceil($left / 60) : 0;
}

function throttle_fail(): void
{
    $d = throttle_read();
    $k = throttle_key();
    $r = $d[$k] ?? ['fails' => 0, 'until' => 0];
    $r['fails'] = ($r['fails'] ?? 0) + 1;
    $r['last'] = time();
    if ($r['fails'] >= (int) config('login_max_attempts', 5)) {
        $r['until'] = time() + 60 * (int) config('login_lock_minutes', 15);
        $r['fails'] = 0;
    }
    $d[$k] = $r;
    throttle_write($d);
}

function throttle_clear(): void
{
    $d = throttle_read();
    unset($d[throttle_key()]);
    throttle_write($d);
}

/* ---------------------------------------------------------------- Setup */

/**
 * One-time setup code. It is written to data/setup-code.txt so only someone
 * with access to the hosting files (cPanel File Manager) can create the admin.
 */
function setup_code(): string
{
    $file = DATA_DIR . '/setup-code.txt';
    if (!is_file($file)) {
        $code = strtoupper(substr(bin2hex(random_bytes(8)), 0, 12));
        file_put_contents($file, $code . "\n", LOCK_EX);
        @chmod($file, 0600);
    }
    return trim((string) file_get_contents($file));
}

function setup_done(): void
{
    @unlink(DATA_DIR . '/setup-code.txt');
}
