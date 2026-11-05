<?php
/**
 * Admin panel: page chrome and form helpers.
 */
defined('MORFIS') || exit;

function admin_nav(): array
{
    return [
        'projects' => ['Projects', url('admin/')],
        'site'     => ['Site & home', url('admin/site.php')],
        'studio'   => ['Studio page', url('admin/studio.php')],
        'contact'  => ['Contact page', url('admin/contact.php')],
        'media'    => ['Media', url('admin/media.php')],
        'account'  => ['Account & backups', url('admin/account.php')],
    ];
}

function admin_head(string $title, string $active = '', bool $chrome = true): void
{
    $site = content()['site'];
    header('Content-Type: text/html; charset=utf-8');
    header('X-Robots-Tag: noindex, nofollow');
    header('Cache-Control: no-store'); ?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title><?= e($title) ?> — <?= e($site['name']) ?> admin</title>
<link rel="icon" href="<?= e(asset('favicon.svg')) ?>" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="<?= e(FONTS_URL) ?>">
<link rel="stylesheet" href="<?= e(asset('admin/assets/admin.css')) ?>">
<script src="<?= e(asset('admin/assets/admin.js')) ?>" defer></script>
</head>
<body class="<?= $chrome ? 'adm' : 'adm adm--bare' ?>">
<?php if ($chrome): ?>
<header class="adm-top">
  <a class="adm-brand" href="<?= e(url('admin/')) ?>"><img src="<?= e(url($site['logo']['src'])) ?>" alt="<?= e($site['name']) ?>"><span>Admin</span></a>
  <button class="adm-menu-btn" type="button" data-adm-menu aria-expanded="false" aria-controls="adm-nav">Menu</button>
  <nav class="adm-nav" id="adm-nav" aria-label="Admin">
    <?php foreach (admin_nav() as $key => [$label, $href]): ?>
      <a href="<?= e($href) ?>"<?= $key === $active ? ' aria-current="page"' : '' ?>><?= e($label) ?></a>
    <?php endforeach; ?>
  </nav>
  <div class="adm-top__end">
    <a class="adm-link" href="<?= e(url()) ?>" target="_blank" rel="noopener">View site ↗</a>
    <form method="post" action="<?= e(url('admin/logout.php')) ?>"><?= csrf_field() ?><button class="adm-link" type="submit">Sign out</button></form>
  </div>
</header>
<?php endif; ?>
<main class="adm-main">
<?php foreach (take_flashes() as $f): ?>
  <div class="adm-flash adm-flash--<?= e($f['type']) ?>" role="status"><?= e($f['message']) ?></div>
<?php endforeach;
}

function admin_foot(): void
{ ?>
</main>
</body>
</html>
<?php
}

/* ------------------------------------------------------------ Form fields */

function f_text(string $name, string $label, $value, string $hint = '', array $attrs = []): string
{
    $id = 'f-' . preg_replace('/[^a-z0-9]+/i', '-', $name);
    $type = $attrs['type'] ?? 'text';
    unset($attrs['type']);
    $a = '';
    foreach ($attrs as $k => $v) {
        $a .= ' ' . $k . ($v === true ? '' : '="' . e($v) . '"');
    }
    return '<div class="fld"><label for="' . $id . '">' . e($label) . '</label>'
        . '<input id="' . $id . '" name="' . e($name) . '" type="' . e($type) . '" value="' . e($value) . '"' . $a . '>'
        . ($hint !== '' ? '<p class="hint">' . $hint . '</p>' : '') . '</div>';
}

function f_area(string $name, string $label, $value, string $hint = '', int $rows = 4, array $attrs = []): string
{
    $id = 'f-' . preg_replace('/[^a-z0-9]+/i', '-', $name);
    $a = '';
    foreach ($attrs as $k => $v) {
        $a .= ' ' . $k . ($v === true ? '' : '="' . e($v) . '"');
    }
    return '<div class="fld"><label for="' . $id . '">' . e($label) . '</label>'
        . '<textarea id="' . $id . '" name="' . e($name) . '" rows="' . $rows . '"' . $a . '>' . e($value) . '</textarea>'
        . ($hint !== '' ? '<p class="hint">' . $hint . '</p>' : '') . '</div>';
}

function f_select(string $name, string $label, $value, array $options, string $hint = ''): string
{
    $id = 'f-' . preg_replace('/[^a-z0-9]+/i', '-', $name);
    $o = '';
    foreach ($options as $opt) {
        $o .= '<option' . ((string) $opt === (string) $value ? ' selected' : '') . '>' . e($opt) . '</option>';
    }
    return '<div class="fld"><label for="' . $id . '">' . e($label) . '</label><select id="' . $id . '" name="' . e($name) . '">' . $o . '</select>'
        . ($hint !== '' ? '<p class="hint">' . $hint . '</p>' : '') . '</div>';
}

/**
 * Repeatable rows of small fields (materials, people, awards, links...).
 * $cols: [key => [label, type ('text'|'color'|'textarea'), width class]]
 */
function f_repeater(string $name, string $title, array $cols, array $rows, string $addLabel, string $hint = ''): string
{
    $row = function ($key, array $values) use ($name, $cols) {
        $h = '<div class="rep-row" data-row>';
        foreach ($cols as $k => [$label, $type, $w]) {
            $field = e($name) . '[' . e($key) . '][' . e($k) . ']';
            $val = (string) ($values[$k] ?? ($type === 'color' ? '#cccccc' : ''));
            $h .= '<label class="rep-cell ' . e($w) . '"><span>' . e($label) . '</span>';
            if ($type === 'textarea') {
                $h .= '<textarea name="' . $field . '" rows="2">' . e($val) . '</textarea>';
            } else {
                $h .= '<input type="' . e($type) . '" name="' . $field . '" value="' . e($val) . '">';
            }
            $h .= '</label>';
        }
        $h .= '<div class="rep-tools"><button type="button" class="icon-btn" data-up aria-label="Move up">↑</button>'
            . '<button type="button" class="icon-btn" data-down aria-label="Move down">↓</button>'
            . '<button type="button" class="icon-btn icon-btn--danger" data-remove aria-label="Remove row">✕</button></div></div>';
        return $h;
    };
    $out = '<fieldset class="rep" data-repeater><legend>' . e($title) . '</legend>';
    if ($hint !== '') {
        $out .= '<p class="hint">' . $hint . '</p>';
    }
    $out .= '<div class="rep-rows" data-rows>';
    foreach (array_values($rows) as $i => $r) {
        $out .= $row('r' . $i, is_array($r) ? $r : []);
    }
    $out .= '</div><template data-template>' . $row('__KEY__', []) . '</template>';
    $out .= '<button type="button" class="btn btn--ghost" data-add>+ ' . e($addLabel) . '</button></fieldset>';
    return $out;
}

/** Collect rows posted by f_repeater, keeping only rows where $required is filled. */
function repeater_rows(string $name, array $keys, string $required, array $max = []): array
{
    $out = [];
    foreach (post_arr($name) as $row) {
        if (!is_array($row)) {
            continue;
        }
        $clean = [];
        foreach ($keys as $k) {
            $clean[$k] = clean_str($row[$k] ?? '', $max[$k] ?? 1000);
        }
        if ($clean[$required] !== '') {
            $out[] = $clean;
        }
    }
    return $out;
}

/**
 * Image list editor with captions, reorder, remove and upload.
 * Posts $name[key][src|caption|remove] and files in "{$name}_new[]".
 */
function f_figures(string $name, string $title, array $figures, string $hint = '', bool $multiple = true): string
{
    $out = '<fieldset class="figs" data-figures><legend>' . e($title) . '</legend>';
    if ($hint !== '') {
        $out .= '<p class="hint">' . $hint . '</p>';
    }
    $out .= '<div class="fig-rows" data-rows>';
    foreach (array_values($figures) as $i => $f) {
        $key = 'f' . $i;
        $field = e($name) . '[' . $key . ']';
        $out .= '<div class="fig-row" data-row>'
            . '<img src="' . e(url($f['src'])) . '" alt="" loading="lazy">'
            . '<input type="hidden" name="' . $field . '[src]" value="' . e($f['src']) . '">'
            . '<div class="fig-row__main"><label class="rep-cell"><span>Caption' . ($i === 0 ? ' · cover image' : '') . '</span>'
            . '<input type="text" name="' . $field . '[caption]" value="' . e($f['caption'] ?? '') . '" maxlength="200"></label>'
            . '<p class="hint">' . (int) $f['w'] . ' × ' . (int) $f['h'] . ' px · ' . e(basename($f['src'])) . '</p></div>'
            . '<div class="rep-tools"><button type="button" class="icon-btn" data-up aria-label="Move up">↑</button>'
            . '<button type="button" class="icon-btn" data-down aria-label="Move down">↓</button>'
            . '<label class="chk chk--danger"><input type="checkbox" name="' . $field . '[remove]" value="1"> Remove</label></div>'
            . '</div>';
    }
    $out .= '</div>';
    $out .= '<label class="drop"><input type="file" name="' . e($name) . '_new[]" accept="image/jpeg,image/png,image/webp"' . ($multiple ? ' multiple' : '') . ' data-file-preview>'
        . '<span><b>Add images</b> — JPG, PNG or WebP, up to ' . (int) config('upload_max_mb', 15) . ' MB each. Large photos are resized to '
        . (int) config('image_max_edge', 2400) . ' px.</span></label><div class="drop-preview" data-preview></div>';
    return $out . '</fieldset>';
}

/** Validate a posted image path: must be an existing image inside images/ or uploads/. */
function figure_from_src(string $src, string $caption): ?array
{
    if (!preg_match('#^(images|uploads)/[A-Za-z0-9/_.-]+\.(jpe?g|png|webp)$#i', $src) || strpos($src, '..') !== false) {
        return null;
    }
    $file = PUBLIC_DIR . '/' . $src;
    $info = is_file($file) ? @getimagesize($file) : false;
    if (!$info) {
        return null;
    }
    return ['src' => $src, 'w' => (int) $info[0], 'h' => (int) $info[1], 'caption' => clean_str($caption, 200)];
}

/**
 * Read a figures editor submission: existing rows (ordered, minus removed) + new uploads.
 * Upload problems are added to $errors.
 */
function figures_from_post(string $name, array &$errors): array
{
    $figs = [];
    foreach (post_arr($name) as $row) {
        if (!is_array($row) || !empty($row['remove'])) {
            continue;
        }
        $f = figure_from_src((string) ($row['src'] ?? ''), (string) ($row['caption'] ?? ''));
        if ($f) {
            $figs[] = $f;
        }
    }
    foreach (files_list($name . '_new') as $file) {
        try {
            $img = store_image($file);
            $figs[] = $img + ['caption' => ''];
        } catch (RuntimeException $ex) {
            $errors[] = $ex->getMessage();
        }
    }
    return $figs;
}

/** Shared POST guard for admin forms. */
function admin_post_guard(): bool
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        return false;
    }
    if (post_too_large()) {
        flash('error', 'That upload was larger than the server allows (' . ini_get('post_max_size') . ' in total). Upload fewer or smaller images at a time.');
        redirect($_SERVER['REQUEST_URI']);
    }
    csrf_check();
    return true;
}
