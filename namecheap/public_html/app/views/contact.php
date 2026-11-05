<?php
/** Contact page.
 * @var array $c
 */
defined('MORFIS') || exit;
$site = $c['site'];
$ct = $c['contact'];
?>
<div class="container contact">
  <div>
    <p class="label">Contact</p>
    <h1 class="display"><?= reveal($ct['headline'], 0.4) ?></h1>
  </div>
  <div class="contact__grid" data-animate style="--d:.7s">
    <div>
      <p class="label">New projects</p>
      <?php if ($site['email'] !== ''): ?><a class="contact__mail hairline-link" href="mailto:<?= e($site['email']) ?>"><?= e($site['email']) ?></a><?php endif; ?>
      <?php if ($site['phone'] !== ''): ?><p class="small" style="margin-top:12px"><?= e($site['phone']) ?></p><?php endif; ?>
      <?php if ($ct['intro'] !== ''): ?><p class="small muted" style="margin-top:24px;max-width:360px"><?= e($ct['intro']) ?></p><?php endif; ?>
    </div>
    <?php foreach ($ct['contacts'] as $x): ?>
    <div><p class="label"><?= e($x['label']) ?></p><p class="serif"><?= e($x['email']) ?></p><?php if ($x['note'] !== ''): ?><p class="small muted" style="margin-top:8px"><?= e($x['note']) ?></p><?php endif; ?></div>
    <?php endforeach; ?>
    <div class="contact__foot">
      <p class="label">© <?= date('Y') ?> <?= e($site['name']) ?></p>
      <ul><?php foreach ($site['social'] as $s): ?><li><a class="hairline-link" href="<?= e($s['url']) ?>" target="_blank" rel="noreferrer"><?= e($s['label']) ?></a></li><?php endforeach; ?></ul>
    </div>
  </div>
</div>
