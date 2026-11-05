<?php
/**
 * Shared start-up for the public site and the admin panel.
 */
define('MORFIS', true);

if (PHP_VERSION_ID < 80000) {
    http_response_code(500);
    exit('Studio Morfis needs PHP 8.0 or newer. In cPanel open "Select PHP Version" and choose 8.1 or higher.');
}

define('APP_DIR', __DIR__);
define('PUBLIC_DIR', dirname(__DIR__));

$GLOBALS['config'] = require APP_DIR . '/config.php';
define('DATA_DIR', rtrim($GLOBALS['config']['data_dir'], '/'));
define('UPLOADS_DIR', rtrim($GLOBALS['config']['uploads_dir'], '/'));

date_default_timezone_set($GLOBALS['config']['timezone'] ?: 'UTC');
mb_internal_encoding('UTF-8');

if ($GLOBALS['config']['debug']) {
    ini_set('display_errors', '1');
    error_reporting(E_ALL);
} else {
    ini_set('display_errors', '0');
    ini_set('log_errors', '1');
    ini_set('error_log', DATA_DIR . '/error.log');
}

require APP_DIR . '/lib/helpers.php';
require APP_DIR . '/lib/store.php';
require APP_DIR . '/lib/auth.php';
require APP_DIR . '/lib/media.php';
require APP_DIR . '/lib/view.php';

foreach ([DATA_DIR, DATA_DIR . '/backups', UPLOADS_DIR] as $dir) {
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
}
