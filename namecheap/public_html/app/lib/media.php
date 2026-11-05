<?php
/**
 * Image uploads: validation, safe file names, orientation fix and down-scaling.
 */
defined('MORFIS') || exit;

const IMAGE_TYPES = [
    'image/jpeg' => 'jpg',
    'image/png'  => 'png',
    'image/webp' => 'webp',
];

/** Turn PHP's $_FILES['x'] (single or multiple) into a list of files. */
function files_list(string $field): array
{
    $f = $_FILES[$field] ?? null;
    if (!$f || !isset($f['name'])) {
        return [];
    }
    if (!is_array($f['name'])) {
        return ($f['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE ? [] : [$f];
    }
    $out = [];
    foreach ($f['name'] as $i => $name) {
        if (($f['error'][$i] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
            continue;
        }
        $out[] = [
            'name' => $name, 'type' => $f['type'][$i] ?? '', 'tmp_name' => $f['tmp_name'][$i] ?? '',
            'error' => $f['error'][$i] ?? UPLOAD_ERR_NO_FILE, 'size' => $f['size'][$i] ?? 0,
        ];
    }
    return $out;
}

/** Files from a nested field like slot[2] (name="slot[2]"). */
function files_list_key(string $field, $key): array
{
    $f = $_FILES[$field] ?? null;
    if (!$f || !isset($f['name'][$key]) || ($f['error'][$key] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        return [];
    }
    return [[
        'name' => $f['name'][$key], 'type' => $f['type'][$key] ?? '', 'tmp_name' => $f['tmp_name'][$key] ?? '',
        'error' => $f['error'][$key], 'size' => $f['size'][$key] ?? 0,
    ]];
}

function upload_error_text(int $code): string
{
    switch ($code) {
        case UPLOAD_ERR_INI_SIZE:
        case UPLOAD_ERR_FORM_SIZE:
            return 'The file is larger than the server allows (' . ini_get('upload_max_filesize') . ').';
        case UPLOAD_ERR_PARTIAL:
            return 'The upload was interrupted. Try again.';
        case UPLOAD_ERR_NO_TMP_DIR:
        case UPLOAD_ERR_CANT_WRITE:
            return 'The server could not store the upload. Contact hosting support.';
        default:
            return 'The upload failed (code ' . $code . ').';
    }
}

/**
 * Store one uploaded image under uploads/YYYY/MM/ and return ['src','w','h'].
 * $keepAlpha keeps PNG/WebP transparency (used for the logo).
 */
function store_image(array $file, bool $keepAlpha = false): array
{
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        throw new RuntimeException(upload_error_text((int) $file['error']));
    }
    if (!is_uploaded_file($file['tmp_name'])) {
        throw new RuntimeException('Upload rejected.');
    }
    $maxBytes = (int) config('upload_max_mb', 15) * 1024 * 1024;
    if ($file['size'] > $maxBytes) {
        throw new RuntimeException(sprintf('"%s" is over %d MB.', $file['name'], config('upload_max_mb', 15)));
    }

    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']) ?: '';
    if (!isset(IMAGE_TYPES[$mime])) {
        throw new RuntimeException(sprintf('"%s" is not a JPG, PNG or WebP image.', $file['name']));
    }
    $info = @getimagesize($file['tmp_name']);
    if (!$info || $info[0] < 1 || $info[1] < 1) {
        throw new RuntimeException(sprintf('"%s" could not be read as an image.', $file['name']));
    }

    $sub = date('Y') . '/' . date('m');
    $dir = UPLOADS_DIR . '/' . $sub;
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        throw new RuntimeException('The uploads folder is not writable. Check its permissions (755).');
    }
    $ext = IMAGE_TYPES[$mime];
    $base = substr(slugify(pathinfo($file['name'], PATHINFO_FILENAME)), 0, 40);
    $name = $base . '-' . bin2hex(random_bytes(4)) . '.' . $ext;
    $dest = $dir . '/' . $name;

    [$w, $h] = [$info[0], $info[1]];
    $processed = process_image($file['tmp_name'], $dest, $mime, $keepAlpha);
    if ($processed) {
        [$w, $h] = $processed;
    } elseif (!move_uploaded_file($file['tmp_name'], $dest)) {
        throw new RuntimeException('Could not save the uploaded file.');
    }
    @chmod($dest, 0644);

    $rel = trim(str_replace('\\', '/', substr(UPLOADS_DIR, strlen(PUBLIC_DIR))), '/');
    return ['src' => $rel . '/' . $sub . '/' . $name, 'w' => (int) $w, 'h' => (int) $h];
}

/**
 * Fix camera rotation and scale down large images with GD.
 * Returns [w, h] when it wrote $dest itself, or null to keep the original file.
 */
function process_image(string $src, string $dest, string $mime, bool $keepAlpha): ?array
{
    if (!extension_loaded('gd')) {
        return null;
    }
    $max = (int) config('image_max_edge', 2400);
    [$w, $h] = getimagesize($src);

    $orientation = 1;
    if ($mime === 'image/jpeg' && function_exists('exif_read_data')) {
        $exif = @exif_read_data($src);
        $orientation = (int) ($exif['Orientation'] ?? 1);
    }
    $needsRotate = in_array($orientation, [3, 6, 8], true);
    if (max($w, $h) <= $max && !$needsRotate) {
        return null;
    }

    switch ($mime) {
        case 'image/jpeg': $img = @imagecreatefromjpeg($src); break;
        case 'image/png':  $img = @imagecreatefrompng($src); break;
        case 'image/webp': $img = function_exists('imagecreatefromwebp') ? @imagecreatefromwebp($src) : false; break;
        default: $img = false;
    }
    if (!$img) {
        return null;
    }

    if ($needsRotate) {
        $angle = [3 => 180, 6 => -90, 8 => 90][$orientation];
        $rotated = imagerotate($img, $angle, 0);
        imagedestroy($img);
        $img = $rotated;
        [$w, $h] = [imagesx($img), imagesy($img)];
    }

    $scale = min(1, $max / max($w, $h));
    $nw = max(1, (int) round($w * $scale));
    $nh = max(1, (int) round($h * $scale));
    $out = imagecreatetruecolor($nw, $nh);
    if ($mime !== 'image/jpeg' || $keepAlpha) {
        imagealphablending($out, false);
        imagesavealpha($out, true);
        imagefill($out, 0, 0, imagecolorallocatealpha($out, 0, 0, 0, 127));
    }
    imagecopyresampled($out, $img, 0, 0, 0, 0, $nw, $nh, $w, $h);
    imagedestroy($img);

    $q = (int) config('image_quality', 84);
    switch ($mime) {
        case 'image/png':  $ok = imagepng($out, $dest, 6); break;
        case 'image/webp': $ok = imagewebp($out, $dest, $q); break;
        default:           imageinterlace($out, true); $ok = imagejpeg($out, $dest, $q);
    }
    imagedestroy($out);
    if (!$ok) {
        throw new RuntimeException('Could not save the resized image.');
    }
    return [$nw, $nh];
}

/** Every uploaded file: [['src','size','time','w','h']], newest first. */
function uploads_all(): array
{
    $out = [];
    if (!is_dir(UPLOADS_DIR)) {
        return $out;
    }
    $rel = trim(str_replace('\\', '/', substr(UPLOADS_DIR, strlen(PUBLIC_DIR))), '/');
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(UPLOADS_DIR, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        $ext = strtolower($f->getExtension());
        if (!in_array($ext, ['jpg', 'jpeg', 'png', 'webp'], true)) {
            continue;
        }
        $path = str_replace('\\', '/', substr($f->getPathname(), strlen(UPLOADS_DIR) + 1));
        $out[] = ['src' => $rel . '/' . $path, 'size' => $f->getSize(), 'time' => $f->getMTime()];
    }
    usort($out, function ($a, $b) {
        return $b['time'] <=> $a['time'];
    });
    return $out;
}

/** Map of image src => list of places that use it. */
function media_usage(array $c): array
{
    $use = [];
    $add = function ($src, $label) use (&$use) {
        if ($src) {
            $use[$src][] = $label;
        }
    };
    $add($c['site']['logo']['src'] ?? '', 'Logo');
    foreach ($c['studio']['figures'] as $i => $f) {
        $add($f['src'] ?? '', 'Studio page, image ' . ($i + 1));
    }
    foreach ($c['projects'] as $p) {
        foreach ($p['figures'] as $f) {
            $add($f['src'] ?? '', $p['title']);
        }
    }
    return $use;
}

/** Delete an uploaded file (only inside the uploads folder). */
function upload_delete(string $src): void
{
    $file = realpath(PUBLIC_DIR . '/' . $src);
    $root = realpath(UPLOADS_DIR);
    if (!$file || !$root || strpos($file, $root . DIRECTORY_SEPARATOR) !== 0 || !is_file($file)) {
        throw new RuntimeException('That file is not in the uploads folder.');
    }
    if (!unlink($file)) {
        throw new RuntimeException('Could not delete the file.');
    }
}
