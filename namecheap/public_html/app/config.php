<?php
/**
 * Studio Morfis — site configuration.
 * Most content is edited in the admin panel (/admin); only technical settings live here.
 */
defined('MORFIS') || exit;

return [
    // Leave empty to detect automatically. Set it (e.g. "/site") only if the site
    // lives in a sub-folder and links come out wrong.
    'base_path' => '',

    // Where content.json, backups and the admin account are stored. The default
    // is public_html/data, which .htaccess keeps private. For extra safety you can
    // move the "data" folder next to public_html and set: dirname(__DIR__, 2) . '/data'
    'data_dir' => dirname(__DIR__) . '/data',

    // Uploaded images (must be inside public_html so visitors can see them).
    'uploads_dir' => dirname(__DIR__) . '/uploads',

    // Images wider or taller than this are scaled down on upload (pixels).
    'image_max_edge' => 2400,
    'image_quality'  => 84,
    'upload_max_mb'  => 15,

    // Number of automatic content backups to keep.
    'backups_keep' => 40,

    // Admin sign-in: lock an address out for 15 minutes after this many failures.
    'login_max_attempts' => 5,
    'login_lock_minutes' => 15,
    'session_idle_minutes' => 120,

    // Show PHP errors in the browser. Keep false on the live site.
    'debug' => false,

    'timezone' => 'UTC',
];
