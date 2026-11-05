<?php
require __DIR__ . '/../app/bootstrap.php';
session_boot();
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    csrf_check();
    logout();
    session_boot();
    flash('ok', 'You are signed out.');
}
redirect(url('admin/login.php'));
