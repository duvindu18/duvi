<?php
/** Studio page.
 * @var array $c
 */
defined('MORFIS') || exit;
$s = $c['studio'];
$fig1 = $s['figures'][0] ?? null;
$fig2 = $s['figures'][1] ?? null;
?>
<div class="container">
  <header class="studio-head">
    <div>
      <p class="label">The studio</p>
      <h1 class="display"><?= reveal($s['headline'], 0.4) ?></h1>
    </div>
    <div class="studio-head__text" data-animate style="--d:.7s">
      <?php foreach ($s['paragraphs'] as $para): ?><p><?= txt($para) ?></p><?php endforeach; ?>
    </div>
  </header>

  <section class="studio-sec">
    <?php if ($fig1): ?>
    <figure class="plate" data-inview>
      <div class="frame" style="aspect-ratio:<?= (int) $fig1['w'] ?>/<?= (int) $fig1['h'] ?>"><?= img_tag($fig1, $fig1['caption'], false, 9) ?></div>
      <figcaption><b>Fig. 01</b><span><?= e($fig1['caption']) ?></span></figcaption>
    </figure>
    <?php else: ?><div></div><?php endif; ?>
    <div><p class="label">Principles</p><ol class="list"><?php foreach ($s['principles'] as $i => $pr): ?><li class="principle"><span class="label label--ink tabular"><?= pad2($i + 1) ?></span><div><h2><?= e($pr['title']) ?></h2><p><?= e($pr['body']) ?></p></div></li><?php endforeach; ?></ol></div>
  </section>

  <?php
  $showPeople = !empty($s['show_people']) && $s['people'];
  $showRecognition = !empty($s['show_recognition']) && $s['recognition'];
  if ($showPeople || $showRecognition): ?>
  <section class="studio-sec">
    <?php if ($showPeople): ?><div><p class="label">People</p><ul class="list"><?php foreach ($s['people'] as $person): ?><li class="person"><span class="serif"><?= e($person['name']) ?></span><span class="label"><?= e($person['role']) ?></span></li><?php endforeach; ?></ul></div><?php else: ?><div></div><?php endif; ?>
    <?php if ($showRecognition): ?><div><p class="label">Recognition</p><ul class="list"><?php foreach ($s['recognition'] as $r): ?><li class="award"><span class="tabular"><?= e($r['year']) ?></span><span><?= e($r['award']) ?></span><span><?= e($r['project']) ?></span></li><?php endforeach; ?></ul></div><?php endif; ?>
  </section>
  <?php endif; ?>

  <?php if ($fig2): ?>
  <figure class="plate" data-inview>
    <div class="frame" style="aspect-ratio:<?= (int) $fig2['w'] ?>/<?= (int) $fig2['h'] ?>"><?= img_tag($fig2, $fig2['caption'], false, 6) ?></div>
    <figcaption><b>Fig. 02</b><span><?= e($fig2['caption']) ?></span></figcaption>
  </figure>
  <?php endif; ?>
</div>
