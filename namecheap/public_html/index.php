<?php
/**
 * Studio Morfis — public site router.
 *
 *   /                    home
 *   /works               index of works
 *   /projects/{slug}     project monograph
 *   /studio, /contact    pages
 *   /sitemap.xml, /robots.txt
 */
require __DIR__ . '/app/bootstrap.php';

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = rawurldecode($path);
$base = base_path();
if ($base !== '' && strpos($path, $base) === 0) {
    $path = substr($path, strlen($base));
}
$path = trim($path, '/');

// Old static-site addresses keep working.
$legacy = [
    'index.html' => '', 'archive.html' => 'works', 'archive' => 'works', 'index' => 'works',
    'studio.html' => 'studio', 'contact.html' => 'contact',
];
if ($path === 'index.php') {
    $path = '';
} elseif (array_key_exists($path, $legacy)) {
    redirect(url($legacy[$path]), 301);
}
if (preg_match('#^projects/([a-z0-9-]+)\.html$#', $path, $m)) {
    redirect(url('projects/' . $m[1]), 301);
}

$c = content();
$projects = published_projects();

switch (true) {
    case $path === '':
        // Mosaic: 9 tiles, cycling through every published figure.
        $pool = [];
        for ($round = 0; $round < 3; $round++) {
            foreach ($projects as $p) {
                if (isset($p['figures'][$round])) {
                    $pool[] = [$p, $p['figures'][$round]];
                }
            }
        }
        $columns = [];
        if ($pool) {
            $columns = [[], [], []];
            for ($i = 0; $i < 9; $i++) {
                $columns[$i % 3][] = $pool[$i % count($pool)];
            }
        }
        $first = $projects[0] ?? null;
        send_page(layout(
            render('home', compact('c', 'projects', 'columns')),
            ['title' => '', 'scripts' => ['js/home.js'], 'path' => '', 'image' => $first ? cover($first) : null, 'edit' => url('admin/site.php')]
        ));
        break;

    case $path === 'works':
        send_page(layout(
            render('works', compact('c', 'projects')),
            ['title' => 'Index', 'description' => 'Index of works by ' . $c['site']['name'] . '.', 'current' => 'works',
             'scripts' => ['js/archive.js'], 'path' => 'works', 'edit' => url('admin/')]
        ));
        break;

    case (bool) preg_match('#^projects/([^/]+)$#', $path, $m):
        $p = find_project('slug', $m[1]);
        $admin = is_admin();
        if (!$p || (empty($p['published']) && !$admin)) {
            send_page(layout(render('404', compact('c')), ['title' => 'Not found', 'noindex' => true, 'path' => $path]), 404);
            break;
        }
        // Position among published projects (drafts get "—").
        $p['index'] = '—';
        $next = null;
        foreach ($projects as $i => $pp) {
            if ($pp['id'] === $p['id']) {
                $p['index'] = $pp['index'];
                $next = count($projects) > 1 ? $projects[($i + 1) % count($projects)] : null;
            }
        }
        if ($p['index'] === '—' && $projects) {
            $next = $projects[0];
        }
        $total = count($projects);
        send_page(layout(
            render('project', compact('c', 'p', 'next', 'total')),
            ['title' => $p['title'], 'description' => $p['lead'] ?: $c['site']['description'], 'current' => 'works',
             'path' => 'projects/' . $p['slug'], 'image' => cover($p), 'draft' => empty($p['published']),
             'noindex' => empty($p['published']), 'edit' => url('admin/project.php?id=' . rawurlencode($p['id']))]
        ));
        break;

    case $path === 'studio':
        send_page(layout(
            render('studio', compact('c')),
            ['title' => 'Studio', 'description' => 'About ' . $c['site']['name'] . '.', 'current' => 'studio',
             'path' => 'studio', 'image' => $c['studio']['figures'][0] ?? null, 'edit' => url('admin/studio.php')]
        ));
        break;

    case $path === 'contact':
        send_page(layout(
            render('contact', compact('c')),
            ['title' => 'Contact', 'description' => 'Contact ' . $c['site']['name'] . '.', 'current' => 'contact',
             'path' => 'contact', 'edit' => url('admin/contact.php')]
        ));
        break;

    case $path === 'sitemap.xml':
        header('Content-Type: application/xml; charset=utf-8');
        $urls = ['', 'works', 'studio', 'contact'];
        foreach ($projects as $p) {
            $urls[] = 'projects/' . $p['slug'];
        }
        echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
        echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n";
        foreach ($urls as $u) {
            echo '  <url><loc>' . e(abs_url($u)) . "</loc></url>\n";
        }
        echo "</urlset>\n";
        break;

    case $path === 'robots.txt':
        header('Content-Type: text/plain; charset=utf-8');
        echo "User-agent: *\nDisallow: " . url('admin/') . "\n\nSitemap: " . abs_url('sitemap.xml') . "\n";
        break;

    default:
        send_page(layout(render('404', compact('c')), ['title' => 'Not found', 'noindex' => true, 'path' => $path]), 404);
}
