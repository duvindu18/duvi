<?php
/** Index of works: filterable / sortable table with cursor preview.
 * @var array $c
 * @var array $projects published projects
 */
defined('MORFIS') || exit;
$typologies = array_values(array_unique(array_filter(array_column($projects, 'typology'), 'strlen')));
$sorted = $projects;
usort($sorted, function ($a, $b) { return (int) $b['year'] <=> (int) $a['year']; });
$total = pad2(count($projects));
?>
<div class="container">
  <header class="archive-head">
    <div>
      <p class="label">Index of works</p>
      <h1 class="display"><?= reveal(['Index'], 0.4) ?></h1>
    </div>
    <div class="archive-head__aside">
      <p><?= e($c['works']['intro']) ?></p>
      <span class="label tabular" data-count><?= $total ?> / <?= $total ?> entries</span>
    </div>
  </header>

  <div class="archive-tools">
    <ul aria-label="Filter by typology"><li><button type="button" class="hairline-link" data-filter="" aria-pressed="true">All</button></li><?php foreach ($typologies as $t): ?><li><button type="button" class="hairline-link" data-filter="<?= e($t) ?>" aria-pressed="false"><?= e($t) ?></button></li><?php endforeach; ?></ul>
    <div class="archive-sort">
      <span class="label">Sort</span>
      <button type="button" data-sort="year" aria-pressed="true">Year</button>
      <button type="button" data-sort="title" aria-pressed="false">Project</button>
      <button type="button" data-sort="city" aria-pressed="false">Location</button>
    </div>
  </div>

  <div class="archive-cols grid-12 label">
    <span>No.</span><span>Project</span><span>Typology</span><span>Location</span><span>Status</span><span>Year</span>
  </div>

  <ul class="rows" data-rows>
<?php foreach ($sorted as $i => $p): ?>
    <li style="--i:<?= $i ?>" data-typology="<?= e($p['typology']) ?>" data-year="<?= e($p['year']) ?>" data-title="<?= e($p['title']) ?>" data-city="<?= e($p['city']) ?>">
      <a class="row" href="<?= e(project_url($p)) ?>" data-preview="<?= e($p['slug']) ?>">
        <span class="label row__no tabular"><?= e($p['index']) ?></span>
        <span class="row__title"><?= e($p['title']) ?></span>
        <span class="row__type"><?= e($p['typology']) ?></span>
        <span class="row__loc"><?= e($p['city']) ?>, <?= e($p['country']) ?></span>
        <span class="row__status"><?= e($p['status']) ?></span>
        <span class="row__year tabular"><?= e($p['year']) ?></span>
      </a>
    </li>
<?php endforeach; ?>
  </ul>
<?php if (!$projects): ?>
  <p class="small muted" style="padding:40px 0">No projects are published yet.</p>
<?php endif; ?>
</div>
<div class="preview" aria-hidden="true" data-preview-box><?php foreach ($projects as $p): $fig = cover($p); if (!$fig) continue; ?><img src="<?= e(url($fig['src'])) ?>" alt="" data-slug="<?= e($p['slug']) ?>" data-tag="<?= e($p['index'] . ' — ' . $p['city']) ?>" loading="lazy"><?php endforeach; ?><span class="tag" data-preview-tag></span></div>
