<?php
/**
 * Content store: one JSON file (data/content.json) with automatic backups.
 */
defined('MORFIS') || exit;

// Visualization statuses first; the architectural ones stay available for later.
const PROJECT_STATUSES = ['Delivered', 'In production', 'Completed', 'In progress', 'Competition', 'Study'];

function content_file(): string
{
    return DATA_DIR . '/content.json';
}

/** The whole site content (cached per request). */
function content(bool $reload = false): array
{
    static $cache = null;
    if ($cache !== null && !$reload) {
        return $cache;
    }
    $raw = is_file(content_file()) ? file_get_contents(content_file()) : '';
    $data = $raw !== '' ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        error_log('content.json is missing or invalid; using empty defaults');
        $data = [];
    }
    return $cache = normalize_content($data);
}

/** Fill in any missing keys so templates never hit undefined indexes. */
function normalize_content(array $c): array
{
    $c += ['site' => [], 'home' => [], 'works' => [], 'studio' => [], 'contact' => [], 'projects' => []];
    $c['site'] += [
        'name' => 'Studio Morfis', 'tagline' => '', 'description' => '', 'descriptor' => 'Architecture Office',
        'founded' => '', 'based' => '', 'email' => '', 'phone' => '', 'logo' => ['src' => 'images/logo.png', 'w' => 1546, 'h' => 503],
        'social' => [],
        // Optional project facts. Off for a visualization studio; switch on in
        // Admin > Site & home for an architectural practice.
        'show_client' => false, 'show_materials' => false,
    ];
    $c['home'] += [
        'kicker' => '', 'headline' => [], 'practice_label' => 'Practice', 'practice' => '', 'chapter_word' => 'Works', 'chapter_number' => '',
        'chapter_text' => '', 'marquee' => '', 'end_text' => '',
    ];
    $c['works'] += ['intro' => ''];
    $c['studio'] += ['headline' => [], 'paragraphs' => [], 'principles' => [], 'people' => [], 'recognition' => [], 'figures' => [],
        'show_people' => false, 'show_recognition' => false];
    $c['contact'] += ['headline' => [], 'intro' => '', 'based_note' => '', 'contacts' => []];
    foreach ($c['projects'] as $i => $p) {
        $c['projects'][$i] = normalize_project(is_array($p) ? $p : []);
    }
    return $c;
}

function normalize_project(array $p): array
{
    $p += [
        'id' => bin2hex(random_bytes(6)), 'slug' => '', 'title' => 'Untitled', 'typology' => '', 'city' => '',
        'country' => '', 'year' => (int) date('Y'), 'status' => PROJECT_STATUSES[0], 'area' => '', 'client' => '',
        'team' => '', 'lead' => '', 'narrative' => [], 'materials' => [], 'figures' => [], 'published' => false,
        'updated' => '',
    ];
    if ($p['slug'] === '' && trim($p['title']) !== '') {
        $p['slug'] = slugify($p['title']);
    }
    return $p;
}

/**
 * Save the content atomically. The previous version is copied to data/backups first.
 */
function content_save(array $data, string $note = 'Edit'): void
{
    $data = normalize_content($data);
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        throw new RuntimeException('Could not encode content.');
    }

    $lock = fopen(DATA_DIR . '/.content.lock', 'c');
    if ($lock === false) {
        throw new RuntimeException('The data folder is not writable. Check its permissions (755).');
    }
    flock($lock, LOCK_EX);
    try {
        if (is_file(content_file())) {
            $stamp = date('Ymd-His');
            $slug = substr(slugify($note), 0, 40);
            @copy(content_file(), DATA_DIR . "/backups/content-$stamp-$slug.json");
            backups_prune();
        }
        $tmp = content_file() . '.tmp-' . bin2hex(random_bytes(4));
        if (file_put_contents($tmp, $json) === false || !rename($tmp, content_file())) {
            @unlink($tmp);
            throw new RuntimeException('Could not write content.json. Check that the data folder is writable.');
        }
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
    content(true);
}

/** Newest first: [['file' => ..., 'time' => ..., 'note' => ..., 'size' => ...]] */
function backups_list(): array
{
    $out = [];
    foreach (glob(DATA_DIR . '/backups/content-*.json') ?: [] as $f) {
        $name = basename($f);
        $note = '';
        if (preg_match('/^content-\d{8}-\d{6}-(.*)\.json$/', $name, $m)) {
            $note = ucfirst(str_replace('-', ' ', $m[1]));
        }
        $out[] = ['file' => $name, 'time' => filemtime($f), 'note' => $note, 'size' => filesize($f)];
    }
    usort($out, function ($a, $b) {
        return $b['time'] <=> $a['time'] ?: strcmp($b['file'], $a['file']);
    });
    return $out;
}

function backups_prune(): void
{
    $keep = max(5, (int) config('backups_keep', 40));
    foreach (array_slice(backups_list(), $keep) as $b) {
        @unlink(DATA_DIR . '/backups/' . $b['file']);
    }
}

function backup_restore(string $file): void
{
    if (!preg_match('/^content-[\w-]+\.json$/', $file) || !is_file(DATA_DIR . '/backups/' . $file)) {
        throw new RuntimeException('That backup no longer exists.');
    }
    $data = json_decode((string) file_get_contents(DATA_DIR . '/backups/' . $file), true);
    if (!is_array($data)) {
        throw new RuntimeException('That backup file is damaged.');
    }
    content_save($data, 'Before restore');
}

/* ------------------------------------------------------------- Projects */

/** Published projects in display order, each with its "index" ("01", "02", ...). */
function published_projects(): array
{
    $out = [];
    $n = 0;
    foreach (content()['projects'] as $p) {
        if (!empty($p['published'])) {
            $p['index'] = pad2(++$n);
            $out[] = $p;
        }
    }
    return $out;
}

function find_project(string $field, string $value): ?array
{
    foreach (content()['projects'] as $i => $p) {
        if ((string) $p[$field] === $value) {
            $p['_pos'] = $i;
            return $p;
        }
    }
    return null;
}

/** Cover image of a project (first figure) or null. */
function cover(array $p): ?array
{
    return $p['figures'][0] ?? null;
}
