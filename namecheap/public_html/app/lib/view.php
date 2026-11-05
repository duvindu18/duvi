<?php
/**
 * Public-site templating: page shell (head, splash, rail, menus) and small
 * markup helpers shared by the views in app/views/.
 */
defined('MORFIS') || exit;

const FONTS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=League+Spartan:wght@300;400;500;600;700;800;900&display=swap';

/** Render app/views/<name>.php with variables and return the HTML. */
function render(string $view, array $vars = []): string
{
    extract($vars, EXTR_SKIP);
    ob_start();
    include APP_DIR . '/views/' . $view . '.php';
    return (string) ob_get_clean();
}

function nav_items(): array
{
    return [
        ['works', 'Index', 'works'],
        ['studio', 'Studio', 'studio'],
        ['contact', 'Contact', 'contact'],
    ];
}

function project_url(array $p): string
{
    return url('projects/' . rawurlencode($p['slug']));
}

/** The studio logo (black artwork; CSS inverts it on dark grounds). */
function logo_img(?string $alt = null): string
{
    $site = content()['site'];
    $logo = $site['logo'];
    $alt = $alt ?? $site['name'];
    return '<img class="logo" src="' . e(url($logo['src'])) . '" width="' . (int) $logo['w'] . '" height="' . (int) $logo['h'] . '" alt="' . e($alt) . '">';
}

/** Masked line-by-line reveal. Lines are plain text; *word* becomes a light accent. */
function reveal(array $lines, float $delay = 0.0): string
{
    $html = '';
    foreach (array_values($lines) as $i => $line) {
        $html .= '<span class="line"><span style="--i:' . $i . '">' . rich($line) . '</span></span>';
    }
    return '<span class="reveal" data-reveal style="--d:' . $delay . 's">' . $html . '</span>';
}

/** <img> for a figure, optionally wrapped for scroll parallax. */
function img_tag(array $fig, string $alt = '', bool $eager = false, ?int $parallax = null): string
{
    $loading = $eager ? 'fetchpriority="high"' : 'loading="lazy"';
    $img = '<img src="' . e(url($fig['src'])) . '" width="' . (int) $fig['w'] . '" height="' . (int) $fig['h'] . '" alt="' . e($alt) . '" ' . $loading . ' decoding="async">';
    if ($parallax !== null) {
        $img = '<div class="parallax-inner" data-parallax="' . $parallax . '">' . $img . '</div>';
    }
    return $img;
}

function frame(array $fig, string $alt = '', string $cls = ''): string
{
    return '<div class="' . e(trim('frame ' . $cls)) . '">' . img_tag($fig, $alt) . '</div>';
}

/** Full HTML document around a page body. */
function layout(string $body, array $meta): string
{
    $c = content();
    $site = $c['site'];
    $title = ($meta['title'] ?? '') !== '' ? $meta['title'] . ' — ' . $site['name'] : $site['name'];
    $description = $meta['description'] ?? $site['description'];
    $current = $meta['current'] ?? '';
    $scripts = array_merge(['js/main.js'], $meta['scripts'] ?? []);
    $ogImage = $meta['image'] ?? null;
    $canonical = abs_url($meta['path'] ?? '');
    $admin = is_admin();

    ob_start(); ?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= e($title) ?></title>
<meta name="description" content="<?= e($description) ?>">
<link rel="canonical" href="<?= e($canonical) ?>">
<meta property="og:type" content="website">
<meta property="og:site_name" content="<?= e($site['name']) ?>">
<meta property="og:title" content="<?= e($title) ?>">
<meta property="og:description" content="<?= e($description) ?>">
<meta property="og:url" content="<?= e($canonical) ?>">
<?php if ($ogImage): ?>
<meta property="og:image" content="<?= e(abs_url($ogImage['src'])) ?>">
<meta name="twitter:card" content="summary_large_image">
<?php endif; ?>
<?php if (!empty($meta['noindex'])): ?>
<meta name="robots" content="noindex">
<?php endif; ?>
<meta name="theme-color" content="#FAFAFA" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0E0E0D" media="(prefers-color-scheme: dark)">
<link rel="icon" href="<?= e(asset('favicon.svg')) ?>" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="<?= e(FONTS_URL) ?>">
<link rel="stylesheet" href="<?= e(asset('css/style.css')) ?>">
<script>
  /* Skip the splash for the rest of the session once seen (runs before paint). */
  try { if (sessionStorage.getItem("morfis:splash")) document.documentElement.setAttribute("data-splash-seen", ""); } catch (e) {}
  /* Apply a saved light/dark choice before paint; otherwise the system setting applies. */
  try { var t = localStorage.getItem("morfis:theme"); if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t); } catch (e) {}
</script>
<?php foreach ($scripts as $s): ?>
<script src="<?= e(asset($s)) ?>" defer></script>
<?php endforeach; ?>
</head>
<body data-page="<?= e($current ?: 'home') ?>">
<a class="sr-only" href="#main">Skip to content</a>
<?= splash_html() ?>
<div id="curtain" aria-hidden="true"></div>
<?= rail_html($current) ?>
<?= mobile_html() ?>
<main id="main" class="page">
<?= $body ?>
</main>
<div class="cursor-label" aria-hidden="true"></div>
<?php if ($admin): ?>
<div class="admin-bar">
  <?php if (!empty($meta['draft'])): ?><span class="admin-bar__draft">Draft: only you can see this page</span><?php endif; ?>
  <a href="<?= e($meta['edit'] ?? url('admin/')) ?>">Edit in admin</a>
</div>
<?php endif; ?>
</body>
</html>
<?php
    return (string) ob_get_clean();
}

function splash_html(): string
{
    $c = content();
    $site = $c['site'];
    $bands = '';
    for ($i = 0; $i < 3; $i++) {
        $marks = str_repeat('<span>' . logo_img('') . '</span>', 10);
        $bands .= '<div class="band' . ($i === 1 ? ' band--light' : '') . '" style="--i:' . $i . '">'
            . '<div class="marquee marquee--' . ($i === 1 ? 'r' : 'l') . '" style="--dur:' . (18 + $i * 4) . 's">' . $marks . '</div></div>' . "\n";
    }
    $strip = '';
    for ($n = 0; $n < 10; $n++) {
        $strip .= '<span>' . $n . '</span>';
    }
    $digits = str_repeat('<span class="digit"><span class="strip">' . $strip . '</span></span>', 3);
    $founded = $site['founded'] !== '' ? '<br>Est. ' . e($site['founded']) : '';

    return '
<div id="splash" role="status" aria-label="Loading ' . e($site['name']) . '">
' . $bands . '  <div class="splash-foot">
    <div><p class="label">Loading</p><p class="label">' . e($c['home']['kicker']) . '</p></div>
    <div class="counter" aria-hidden="true">' . $digits . '<span class="counter-unit">%</span></div>
  </div>
  <div class="splash-resolved">
    ' . logo_img() . '
    <p class="label">' . e($site['tagline']) . $founded . '</p>
  </div>
  <div class="splash-meta"><span class="label">' . e($site['name']) . '</span><span class="label">' . e($site['descriptor']) . '</span></div>
</div>';
}

function theme_toggle(): string
{
    return '<button class="theme-toggle" type="button" aria-pressed="false" data-theme-toggle><span class="dot" aria-hidden="true"></span><span data-theme-label>Dark mode</span></button>';
}

function rail_html(string $current): string
{
    $site = content()['site'];
    $items = '';
    foreach (nav_items() as $i => [$path, $label, $key]) {
        $cur = $key === $current;
        $items .= '<li class="' . ($cur ? 'is-current' : '') . '" data-animate style="--d:' . number_format(0.1 + $i * 0.07, 2) . 's">'
            . '<span class="tick"></span><a href="' . e(url($path)) . '"' . ($cur ? ' aria-current="page"' : '') . '>' . e($label) . "</a></li>\n";
    }
    $social = '';
    foreach ($site['social'] as $s) {
        $social .= '<li><a class="label hairline-link" href="' . e($s['url']) . '" target="_blank" rel="noreferrer" aria-label="' . e($s['label']) . '">' . e($s['short']) . '</a></li>';
    }
    return '
<aside class="rail">
  <div class="rail__brand" data-animate>
    <a href="' . e(url()) . '" aria-label="' . e($site['name']) . ', home">' . logo_img() . '</a>
    <p class="label">' . e($site['descriptor']) . '</p>
  </div>
  <nav class="rail__nav" aria-label="Primary">
    <ul>
' . $items . '    </ul>
    <a class="btn-dark" href="' . e(url('contact')) . '">Start a project</a>
  </nav>
  <div>
    <div class="rail__theme">' . theme_toggle() . '</div>
    <div class="rail__foot"><ul>' . $social . '</ul><span class="label">© ' . date('Y') . '</span></div>
  </div>
</aside>';
}

function mobile_html(): string
{
    $site = content()['site'];
    $links = array_merge([['', 'Home']], array_map(function ($n) {
        return [$n[0], $n[1]];
    }, nav_items()));
    $items = '';
    foreach ($links as $i => [$path, $label]) {
        $items .= '<li><a href="' . e(url($path)) . '"><span class="serif">' . e($label) . '</span><span class="label">' . pad2($i + 1) . '</span></a></li>';
    }
    $mail = $site['email'] !== '' ? '<a href="mailto:' . e($site['email']) . '">' . e($site['email']) . '</a>' : '';
    return '
<header class="mobile-bar">
  <a href="' . e(url()) . '" aria-label="' . e($site['name']) . ', home">' . logo_img() . '</a>
  <button class="menu-btn" type="button" aria-expanded="false" aria-controls="mobile-menu" data-menu-toggle>
    <span data-menu-label>Menu</span><span class="bars"><i></i><i></i></span>
  </button>
</header>
<div class="mobile-menu" id="mobile-menu">
  <nav aria-label="Primary"><ul>' . $items . '</ul></nav>
  <div class="mobile-menu__foot">
    ' . theme_toggle() . '
    ' . $mail . '
  </div>
</div>';
}

/** Send a page with an HTTP status. */
function send_page(string $html, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    echo $html;
}
