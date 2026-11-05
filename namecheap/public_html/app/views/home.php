<?php
/** Home: intro, image mosaic, chapter title, project panels / cards, link to the index.
 * @var array $c       all content
 * @var array $projects published projects
 * @var array $columns  three mosaic columns of [project, figure]
 */
defined('MORFIS') || exit;
$site = $c['site'];
$home = $c['home'];
$run = $home['marquee'] !== '' ? str_repeat(rtrim(tokens($home['marquee'])) . ' ', 3) : '';
$experience = years_experience();
?>
<section class="home" aria-label="Selected works">
  <div class="track" data-track>

    <div class="panel intro" data-snap>
      <p class="label" data-animate="fade" style="--d:.6s"><?= txt($home['kicker']) ?></p>
      <h1 class="display"><?= reveal($home['headline'], 0.15) ?></h1>
      <div class="intro__facts" data-animate style="--d:.7s">
        <p><?= txt($site['description']) ?></p>
        <dl>
          <?php if ($site['founded'] !== ''): ?><dt class="label">Founded</dt><dd><?= e($site['founded']) ?></dd><?php endif; ?>
          <?php if ($experience): ?><dt class="label">Experience</dt><dd><?= $experience ?> year<?= $experience === 1 ? '' : 's' ?></dd><?php endif; ?>
          <?php if ($home['practice'] !== ''): ?><dt class="label"><?= e($home['practice_label'] ?: 'Practice') ?></dt><dd><?= txt($home['practice']) ?></dd><?php endif; ?>
        </dl>
      </div>
    </div>

<?php if ($columns): ?>
    <div class="panel mosaic" data-snap data-mosaic>
      <div class="mosaic__grid"><?php foreach ($columns as $ci => $col): ?><div class="mosaic__col" data-col="<?= $ci ?>"><?php foreach ($col as [$p, $fig]): ?><a href="<?= e(project_url($p)) ?>" data-cursor="<?= e($p['title']) ?>"><?= frame($fig, $p['title'] . ': ' . $fig['caption'], 'frame--hover') ?></a><?php endforeach; ?></div><?php endforeach; ?></div>
    </div>
<?php endif; ?>

    <div class="panel chapter" data-snap>
      <?php if ($run !== ''): ?><div class="chapter__run"><div class="marquee marquee--l" style="--dur:40s"><span class="label"><?= e($run) ?></span><span class="label"><?= e($run) ?></span></div></div><?php else: ?><div></div><?php endif; ?>
      <div class="chapter__body">
        <p class="chapter__big"><?= e($home['chapter_word']) ?></p>
        <div class="chapter__row">
          <p class="chapter__num"><?= txt($home['chapter_number']) ?></p>
          <p><?= txt($home['chapter_text']) ?></p>
        </div>
      </div>
      <div class="chapter__foot"><span class="label">Chapter 01</span><span class="label"><?= pad2(count($projects)) ?> projects</span></div>
    </div>

    <div class="panels" data-panels>
<?php foreach ($projects as $i => $p): $fig = cover($p); ?>
      <a class="p-panel<?= $i === 0 ? ' is-active' : '' ?>" href="<?= e(project_url($p)) ?>" data-snap data-cursor="View project">
        <div class="p-panel__media" aria-hidden="true"><?= $fig ? frame($fig) : '' ?></div>
        <div class="p-panel__body">
          <div class="p-panel__num"><strong><?= e($p['index']) ?></strong><small>’<?= e(substr((string) $p['year'], -2)) ?></small></div>
          <div class="p-panel__meta"><b><?= e($p['city']) ?> / <?= e($p['country']) ?></b><br><?= e($p['typology']) ?><br><?= e($p['year']) ?></div>
          <h2 class="p-panel__title"><?= e($p['title']) ?></h2>
          <div class="p-panel__foot">
            <span class="p-panel__status"><?= e($p['status']) ?></span>
            <span class="p-panel__cta">See project <i>→</i></span>
          </div>
        </div>
      </a>
<?php endforeach; ?>
    </div>

    <div class="cards">
<?php foreach ($projects as $p): $fig = cover($p); ?>
      <a class="card" href="<?= e(project_url($p)) ?>">
        <div class="frame" style="aspect-ratio:4/5"><?= $fig ? img_tag($fig, $p['title']) : '' ?><span class="card__num"><?= e($p['index']) ?></span></div>
        <div class="card__head"><h2 class="serif"><?= e($p['title']) ?></h2><span class="label"><?= e($p['year']) ?></span></div>
        <p class="label"><?= e($p['city']) ?>, <?= e($p['country']) ?> — <?= e($p['typology']) ?></p>
      </a>
<?php endforeach; ?>
    </div>

    <div class="panel end" data-snap>
      <p class="label">Continue</p>
      <a class="serif" href="<?= e(url('works')) ?>" data-cursor="Open index">The full<br><em>index</em><span class="arrow">→</span></a>
      <p class="tiny muted"><?= txt($home['end_text']) ?></p>
    </div>
  </div>

  <div class="track-foot">
    <span class="label">Scroll or use ← →</span>
    <div class="progress"><i data-progress></i></div>
    <div class="track-foot__btns">
      <button class="round-btn" type="button" aria-label="Previous" data-prev>←</button>
      <button class="round-btn" type="button" aria-label="Next" data-next>→</button>
    </div>
  </div>
</section>
