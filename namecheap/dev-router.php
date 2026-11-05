<?php
/**
 * Local preview only (not uploaded): mimics the .htaccess rules for PHP's
 * built-in server.
 *
 *   php -S localhost:8080 -t public_html dev-router.php
 */
$uri = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');
if (preg_match('#^/(app|data)(/|$)#', $uri) || preg_match('#/\.#', $uri)) {
    http_response_code(403);
    exit('Forbidden');
}
$file = __DIR__ . '/public_html' . $uri;
if ($uri !== '/' && (is_file($file) || is_dir($file))) {
    return false; // let the built-in server serve the file / run the PHP script
}
require __DIR__ . '/public_html/index.php';
