<?php
/** Project monograph.
 * @var array  $p     the project (with "index")
 * @var int    $total number of published projects
 * @var ?array $next  next published project, or null
 */
defined('MORFIS') || exit;
$words = preg_split('/\s+/u', trim($p['title'])) ?: [$p['title']];
$titleLines = array_map(function ($chunk) { return implode(' ', $chunk); }, array_chunk($words, 2));
$showClient = !empty($c['site']['show_client']);
$showMaterials = !empty($c['site']['show_materials']);
$specs = array_filter([
    'Year' => $p['year'], 'Location' => trim($p['city'] . ', ' . $p['country'], ', '), 'Typology' => $p['typology'],
    'Status' => $p['status'], 'Area' => $p['area'], 'Client' => $showClient ? $p['client'] : '',
], function ($v) { return (string) $v !== ''; });
$figs = $p['figures'];
$inset = $figs[1] ?? ($figs[0] ?? null);
$plate = $figs[2] ?? ($figs[0] ?? null);
$page = is_numeric($p['index']) ? (int) $p['index'] * 12 : 0;
$nextFig = $next ? cover($next) : null;
?>
<article>
  <div class="mono">
    <header class="mono__text">
      <div class="mono__top">
        <a class="label hairline-link" href="<?= e(url('works')) ?>">← Index</a>
        <span class="label tabular"><?= e($p['index']) ?> / <?= pad2($total) ?></span>
      </div>
      <div>
        <p class="label label--wide"><?= e($p['title']) ?></p>
        <h1 class="display mono__title"><?= reveal($titleLines, 0.45) ?></h1>
        <?php if ($p['lead'] !== ''): ?><p class="mono__lead" data-animate style="--d:.8s"><?= e($p['lead']) ?></p><?php endif; ?>
      </div>
      <div data-animate style="--d:.9s">
        <dl class="specs"><?php foreach ($specs as $k => $v): ?><div><dt class="label"><?= e($k) ?></dt><dd><?= e($v) ?></dd></div><?php endforeach; ?></dl>
        <?php if ($showMaterials && $p['materials']): ?>
        <div class="materials"><p class="label">Materials</p><ul><?php foreach ($p['materials'] as $m): ?><li><span class="swatch" style="background:<?= is_hex_color($m['swatch'] ?? '') ? e($m['swatch']) : '#cccccc' ?>"></span><span><?= e($m['name']) ?></span><span class="note"><?= e($m['note']) ?></span></li><?php endforeach; ?></ul></div>
        <?php endif; ?>
      </div>
    </header>
    <div class="mono__plates">
<?php foreach ($figs as $n => $f): ?>
      <figure class="plate" data-inview>
        <div class="frame frame--hover" style="aspect-ratio:<?= (int) $f['w'] ?>/<?= (int) $f['h'] ?>"><?= img_tag($f, $p['title'] . ($f['caption'] !== '' ? ': ' . $f['caption'] : ''), $n === 0, 9) ?></div>
        <figcaption><b class="tabular">Fig. <?= pad2($n + 1) ?></b><span><?= e($f['caption']) ?></span></figcaption>
      </figure>
<?php endforeach; ?>
    </div>
  </div>

<?php if ($p['narrative'] && $inset && $plate): ?>
  <section class="spread" aria-label="Project text">
    <div class="spread__meta"><p class="label">Monograph</p><?php if ($page): ?><p class="label">pp. <?= $page ?> — <?= $page + 1 ?></p><?php endif; ?></div>
    <div class="spread__book" data-animate>
      <div class="spread__page">
        <p class="spread__kicker"><?= e($p['title']) ?></p>
        <div class="spread__inset"><?= frame($inset, $inset['caption']) ?></div>
        <hr>
        <div class="spread__text"><?php foreach ($p['narrative'] as $para): ?><p><?= e($para) ?></p><?php endforeach; ?></div>
        <p class="spread__credit"><?= e($p['title']) ?> by <?= e($c['site']['name']) ?><?= $p['team'] !== '' ? ' — ' . e($p['team']) : '' ?></p>
      </div>
      <div class="spread__plate"><?= frame($plate, $plate['caption']) ?></div>
    </div>
  </section>
<?php endif; ?>

<?php if ($next): ?>
  <a class="next" href="<?= e(project_url($next)) ?>" data-cursor="Next project">
    <div class="next__text">
      <span class="label">Next project — <?= e($next['index']) ?></span>
      <span class="display next__title"><?= e($next['title']) ?> →</span>
      <span class="label"><?= e($next['city']) ?>, <?= e($next['country']) ?> — <?= e($next['year']) ?></span>
    </div>
    <div class="next__img"><?= $nextFig ? frame($nextFig) : '' ?></div>
  </a>
<?php endif; ?>
</article>
