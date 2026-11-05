<?php
/**
 * Small helpers shared by the site and the admin panel.
 */
defined('MORFIS') || exit;

function config(string $key, $default = null)
{
    return $GLOBALS['config'][$key] ?? $default;
}

/** Escape for HTML text and attributes. */
function e($value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Escape, then turn *word* into a light-weight accent (<em>). */
function rich(string $text): string
{
    return preg_replace('/\*(.+?)\*/u', '<em>$1</em>', e($text));
}

/** Two-digit index: 1 -> "01". */
function pad2($n): string
{
    return str_pad((string) $n, 2, '0', STR_PAD_LEFT);
}

/** URL path prefix when the site lives in a sub-folder ("" at the domain root). */
function base_path(): string
{
    static $base = null;
    if ($base !== null) {
        return $base;
    }
    $configured = trim((string) config('base_path', ''));
    if ($configured !== '') {
        return $base = '/' . trim($configured, '/');
    }
    $docRoot = realpath($_SERVER['DOCUMENT_ROOT'] ?? '') ?: '';
    $public = realpath(PUBLIC_DIR) ?: PUBLIC_DIR;
    if ($docRoot !== '' && strpos($public, $docRoot) === 0) {
        $rel = str_replace('\\', '/', substr($public, strlen($docRoot)));
        return $base = rtrim($rel, '/');
    }
    return $base = '';
}

/** Site URL for a path: url('works') -> "/works", url() -> "/". */
function url(string $path = ''): string
{
    return base_path() . '/' . ltrim($path, '/');
}

/** Absolute URL including scheme and host (sitemap, social previews). */
function abs_url(string $path = ''): string
{
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    return ($https ? 'https' : 'http') . '://' . $host . url($path);
}

/** Static file URL with a cache-busting version from its modification time. */
function asset(string $path): string
{
    $file = PUBLIC_DIR . '/' . ltrim($path, '/');
    $v = is_file($file) ? filemtime($file) : 0;
    return url($path) . '?v=' . $v;
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
}

function redirect(string $to, int $code = 303): void
{
    header('Location: ' . $to, true, $code);
    exit;
}

/** Trimmed string from POST. */
function post_str(string $key, string $default = ''): string
{
    $v = $_POST[$key] ?? $default;
    return is_string($v) ? trim(str_replace("\r\n", "\n", $v)) : $default;
}

function post_arr(string $key): array
{
    $v = $_POST[$key] ?? [];
    return is_array($v) ? $v : [];
}

/** Clean one string value from a nested POST array. */
function clean_str($v, int $max = 2000): string
{
    if (!is_string($v)) {
        return '';
    }
    $v = trim(str_replace("\r\n", "\n", $v));
    return mb_substr($v, 0, $max);
}

/** Split a textarea into paragraphs separated by blank lines. */
function paragraphs(string $text): array
{
    $parts = preg_split('/\n\s*\n/u', trim($text)) ?: [];
    return array_values(array_filter(array_map(function ($p) {
        return trim(preg_replace('/\s*\n\s*/u', ' ', $p));
    }, $parts), 'strlen'));
}

/** Split a textarea into non-empty lines. */
function lines(string $text): array
{
    return array_values(array_filter(array_map('trim', explode("\n", $text)), 'strlen'));
}

function slugify(string $text): string
{
    $text = mb_strtolower($text);
    if (function_exists('transliterator_transliterate')) {
        $t = transliterator_transliterate('Any-Latin; Latin-ASCII', $text);
        if ($t !== false) {
            $text = $t;
        }
    } elseif (function_exists('iconv')) {
        $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $text);
        if ($t !== false) {
            $text = $t;
        }
    }
    $text = preg_replace('/[^a-z0-9]+/', '-', $text);
    return trim($text, '-') ?: 'project';
}

function is_hex_color(string $v): bool
{
    return (bool) preg_match('/^#[0-9a-fA-F]{6}$/', $v);
}

/* ----------------------------------------------------------------- Sessions */

/** Start the session (admin) with hardened cookie settings. */
function session_boot(bool $readOnly = false): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    session_name('morfis_admin');
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => base_path() . '/',
        'secure'   => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    ini_set('session.use_strict_mode', '1');
    if ($readOnly) {
        session_start(['read_and_close' => true]);
    } else {
        session_start();
    }
}

/* --------------------------------------------------------------------- CSRF */

function csrf_token(): string
{
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf'];
}

function csrf_field(): string
{
    return '<input type="hidden" name="_csrf" value="' . e(csrf_token()) . '">';
}

function csrf_check(): void
{
    $sent = $_POST['_csrf'] ?? '';
    if (!is_string($sent) || empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], $sent)) {
        http_response_code(400);
        exit('This form has expired. Go back, reload the page and try again.');
    }
}

/* ------------------------------------------------------------------- Flash */

function flash(string $type, string $message): void
{
    $_SESSION['flash'][] = ['type' => $type, 'message' => $message];
}

function take_flashes(): array
{
    $f = $_SESSION['flash'] ?? [];
    unset($_SESSION['flash']);
    return $f;
}

/** True when a POST was larger than post_max_size (PHP then drops all fields). */
function post_too_large(): bool
{
    return ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST'
        && empty($_POST) && empty($_FILES)
        && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0;
}
