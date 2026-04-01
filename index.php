<?php
// --- Récupération des images ---
if(isset($_ENV['PANORAMAX_URL'])) {
  $geojsonContent = file_get_contents($_ENV['PANORAMAX_URL']);
  if ($geojsonContent === false) {
    die("Impossible de lire le fichier GeoJSON depuis l'URL.");
  } 
  $data = json_decode($geojsonContent, true);
  $images = [];
  $metadatas = [];
 
  $root_dir = "datas/";
  $bg_commands = [];
  foreach($data['features'] as $item) {
    $storage_dir = $root_dir . $item['collection'] . '/';
    if (!is_dir($storage_dir)) mkdir($storage_dir, 0777, true);
    $remote_url = $item['assets']['sd']['href'];
    $props = $item['properties'];
    $id = $item['id'] ?? md5($remote_url);
    $local_path = $storage_dir . $id . ".jpg";

    $exifs[$local_path]['PosePitchDegrees']   = $props['pers:pitch'] ?? $props['exif']['Xmp.GPano.PosePitchDegrees'] ?? 0;
    $exifs[$local_path]['PoseRollDegrees']    = $props['pers:roll']  ?? $props['exif']['Xmp.GPano.PoseRollDegrees'] ?? 0;
    $exifs[$local_path]['PoseHeadingDegrees'] = $props['pers:yaw']   ?? $props['exif']['Xmp.GPano.PoseHeadingDegrees'] ?? 0;

    if (!file_exists($local_path)) {
        $y = $exifs[$local_path]['PoseHeadingDegrees'];
        $p = $exifs[$local_path]['PosePitchDegrees'];
        $r = $exifs[$local_path]['PoseRollDegrees'];

        $bg_commands[] = "(" .
            "curl -L -s -o " . escapeshellarg($local_path) . " " . escapeshellarg($remote_url) . " && " .
            "sleep 0.3 && " .
            "W=$(exiftool -S -T -ImageWidth " . escapeshellarg($local_path) . ") && " .
            "H=$(exiftool -S -T -ImageHeight " . escapeshellarg($local_path) . ") && " .
            "exiftool -overwrite_original " .
            "-XMP-GPano:PoseHeadingDegrees=" . escapeshellarg((string)$y) . " " .
            "-XMP-GPano:PosePitchDegrees=" . escapeshellarg((string)$p) . " " .
            "-XMP-GPano:PoseRollDegrees=" . escapeshellarg((string)$r) . " " .
            "-XMP-GPano:FullPanoWidthPixels=\$W " .
            "-XMP-GPano:FullPanoHeightPixels=\$H " .
            "-XMP-GPano:CroppedAreaImageWidthPixels=\$W " .
            "-XMP-GPano:CroppedAreaImageHeightPixels=\$H " .
            "-XMP-GPano:CroppedAreaLeftPixels=0 " .
            "-XMP-GPano:CroppedAreaTopPixels=0 " .
            escapeshellarg($local_path) .
            ")";
    }


    $images[] = $local_path;
  }
  if (!empty($bg_commands) && isset($storage_dir)) {
    $lock_file = $storage_dir . "download.lock";
    if (!file_exists($lock_file)) {
      shell_exec("(touch " . escapeshellarg($lock_file) . " && " . implode(" && ", $bg_commands) . " && rm " . escapeshellarg($lock_file) . ") > /dev/null 2>&1 &");
    }
  }
}

else {
  $images = array_merge(glob("images/*.jpg"), glob("images/*.JPG"), glob("images/*/*.jpg"),  glob("images/*/*.JPG"));
  natsort($images);
}


$images = array_values($images);
$img_current = isset($_GET['img']) ? (int)$_GET['img'] : 0;

$missing_count = 0;
if (isset($_ENV['PANORAMAX_URL'])) {
    foreach ($images as $img) {
        if (!file_exists($img)) $missing_count++;
    }
}
$current_image_exists = file_exists($images[$img_current] ?? '');

// --- Lecture des métadonnées EXIF ---
function getExifValue(string $file, string $tag): float {
    $value = trim((string)shell_exec("exiftool -s -s -s -XMP-GPano:$tag " . escapeshellarg($file)));
    return $value !== '' ? (float)$value : 0;
}

$roll  = getExifValue($images[$img_current], 'PoseRollDegrees');
$pitch = getExifValue($images[$img_current], 'PosePitchDegrees');
$yaw   = getExifValue($images[$img_current], 'PoseHeadingDegrees');

$reset_pitch = False;

// --- Mise à jour des EXIF si formulaire soumis ---
if (isset($_POST['update_exif'])) {
    $step = 1;
    $action = $_POST['update_exif'];

    // Détermination du pas
    if (preg_match('/_5$/', $action))  $step = 5;
    if (preg_match('/_10$/', $action)) $step = 10;

    $param = null;
    $change_value = null;

    $current_pitch = isset($_GET['pitch']) ? $_GET['pitch'] : 0;
    $current_yaw = isset($_GET['yaw']) ? $_GET['yaw'] : 0;

    switch ($action) {
        case 'roll_plus':
        case 'roll_plus_5':
        case 'roll_plus_10':
            $param = 'PoseRollDegrees';
            $change_value = $roll += $step;
            break;
        case 'roll_reset':
            $param = 'PoseRollDegrees';
            $change_value = $roll = 0;
            break;
        case 'roll_fix': 
            $param = 'PoseRollDegrees';
            if($current_yaw < 0) {
              $change_value = $roll = $current_pitch ? (float)$roll-$current_pitch : $roll;
            }
            else {
              $change_value = $roll = $current_pitch ? (float)$roll+$current_pitch : $roll;
            }
            $reset_pitch = True;
            break;

        case 'roll_minus':
        case 'roll_minus_5':
        case 'roll_minus_10':
            $param = 'PoseRollDegrees';
            $change_value = $roll -= $step;
            break;

        case 'pitch_plus':
        case 'pitch_plus_5':
        case 'pitch_plus_10':
            $param = 'PosePitchDegrees';
            $change_value = $pitch += $step;
            break;
        case 'pitch_reset':
            $param = 'PosePitchDegrees';
            $change_value = $pitch = 0;
            break;
        case 'pitch_fix':
            $param = 'PosePitchDegrees';
            if(($current_yaw <= 0 && $current_yaw > -90) || ($current_yaw >= 0 && $current_yaw < 90)) {
              $change_value = $pitch = $current_pitch ? (float)$pitch-$current_pitch : $pitch;
            }
            else {
              $change_value = $pitch = $current_pitch ? (float)$pitch+$current_pitch : $pitch;
            }
            $reset_pitch = True;
            break;
        case 'pitch_minus':
        case 'pitch_minus_5':
        case 'pitch_minus_10':
            $param = 'PosePitchDegrees';
            $change_value = $pitch -= $step;
            break;
        case 'yaw_fix':
            $param = 'PoseHeadingDegrees';
            $change_value = $yaw = $current_yaw ? (float)$current_yaw : $yaw;
            break;
    }

    if ($param !== null) {
        shell_exec(
            'exiftool -overwrite_original -XMP-GPano:' .
            escapeshellarg($param) . '=' . escapeshellarg($change_value) . ' ' .
            escapeshellarg($images[$img_current])
        );
    }
}
// --- Sync results back to Panoramax API ---
if (isset($_POST['sync_api']) && isset($_ENV['PANORAMAX_URL']) && isset($_ENV['PANORAMAX_TOKEN'])) {
    $token = $_ENV['PANORAMAX_TOKEN'];
    $url_parts = parse_url($_ENV['PANORAMAX_URL']);
    $api_base = $url_parts['scheme'] . '://' . $url_parts['host'] . (isset($url_parts['port']) ? ':' . $url_parts['port'] : '') . '/api';
    
    $success_count = 0;
    $root_dir = "datas/";
    $last_storage_dir = null;

        foreach ($data['features'] as $item) {
            $collection_id = $item['collection'];
            $item_id = $item['id'];
            $storage_dir = $root_dir . $collection_id . '/';
            $last_storage_dir = $storage_dir;
            $local_path = $storage_dir . $item_id . ".jpg";

            if (file_exists($local_path)) {
                $p = getExifValue($local_path, 'PosePitchDegrees') ;
                $r = getExifValue($local_path, 'PoseRollDegrees');
                $y = getExifValue($local_path, 'PoseHeadingDegrees');

                // Original values from Panoramax (for comparison)
                $props = $item['properties'];
                $op = (float)($props['pers:pitch'] ?? $props['exif']['Xmp.GPano.PosePitchDegrees'] ?? 0);
                $or = (float)($props['pers:roll']  ?? $props['exif']['Xmp.GPano.PoseRollDegrees'] ?? 0);
                $oy = (float)($props['pers:yaw']   ?? $props['exif']['Xmp.GPano.PoseHeadingDegrees'] ?? 0);

                // Only sync if values have changed (rounding to avoid float precision issues)
                if (round($p, 4) != round($op, 4) || round($r, 4) != round($or, 4) || round($y, 4) != round($oy, 4)) {
                    $patch_url = "$api_base/collections/$collection_id/items/$item_id";
                    $patch_data = json_encode(['pitch' => $p,  'roll' => $r, 'yaw' => $y]);

                    $ch = curl_init($patch_url);
                    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'PATCH');
                    curl_setopt($ch, CURLOPT_POSTFIELDS, $patch_data);
                    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
                    curl_setopt($ch, CURLOPT_HTTPHEADER, [
                        'Content-Type: application/json',
                        'Authorization: Bearer ' . $token,
                        'accept: application/geo+json'
                    ]);

                    $response = curl_exec($ch);
                    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                    curl_close($ch);

                    if ($status >= 200 && $status < 300) {
                        $success_count++;
                    }
                    usleep(300000); // 0.3s delay between updates
                }
            }
        }

        if ($last_storage_dir && is_dir($last_storage_dir)) {
            shell_exec("rm -rf " . escapeshellarg($last_storage_dir));
            $sync_result = "Sync completed: $success_count pictures updated. Local storage cleaned.";
        } else {
            $sync_result = "Sync finished ($success_count pictures updated).";
        }
}
?>
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>Visionneuse Pannellum</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/pannellum/build/pannellum.css"/>
    <style>
        .loader-overlay {
            position: fixed;
            top: 10px;
            right: 10px;
            background: rgba(0, 0, 0, 0.8);
            padding: 10px 20px;
            border-radius: 5px;
            border: 1px solid #4CAF50;
            z-index: 1000;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .spinner {
            width: 20px;
            height: 20px;
            border: 3px solid #f3f3f3;
            border-top: 3px solid #4CAF50;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .loader-overlay.full-screen {
            top: 0; right: 0; bottom: 0; left: 0;
            margin: auto;
            width: fit-content;
            height: fit-content;
            box-shadow: 0 0 100px rgba(0,0,0,0.9);
            padding: 30px 50px;
            font-size: 20px;
        }
        body {
            margin: 0;
            font-family: sans-serif;
            background: #222;
            color: #fff;
            text-align: center;
        }
        #viewer-container {
            position: relative;
            width: 100%;
            height: 80vh;
        }
        #panorama { width: 100%; height: 100%; }
        #filename {
            position: absolute;
            bottom: 10px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 18px;
            font-weight: bold;
            background: rgba(0,0,0,0.6);
            padding: 5px 12px;
            border-radius: 5px;
        }
        .controls { margin-top: 10px; }
        button {
            padding: 2px 5px;
            font-size: 16px;
            margin: 0 5px;
            cursor: pointer;
        }
        #crosshair {
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            pointer-events: none;
        }
        #crosshair div {
            position: absolute;
            background: red;
        }
        #crosshair .hline {
            top: 50%; left: 0;
            width: 100%; height: 2px;
            transform: translateY(-50%);
        }
        #crosshair .vline {
            top: 0; left: 50%;
            width: 2px; height: 100%;
            transform: translateX(-50%);
        }
    </style>
    <script>
    const urlParams = new URLSearchParams(window.location.search);
    let currentIndex = parseInt(urlParams.get('img')) || 0;
    <?php
    if($reset_pitch) {
    ?>
    let currentPitch = 0;
    <?php }
    else { ?>
    let currentPitch = parseFloat(urlParams.get('pitch')) || 0;
    <?php } ?>
    let currentYaw   = parseFloat(urlParams.get('yaw')) || <?= $yaw ?>;
    let currentHfov  = parseFloat(urlParams.get('fov')) || 120;
    </script>
</head>
<body>
    <?php if ($missing_count > 0): ?>
    <div class="loader-overlay" <?= $current_image_exists ? 'style="opacity: 0.5; border-color: orange;"' : '' ?>>
        <div class="spinner"></div>
        <span>Téléchargement de la séquence : <b><?= $missing_count ?></b> images restantes...</span>
        <?php if (!$current_image_exists): ?>
            <script>setTimeout(() => location.reload(), 3000);</script>
        <?php endif; ?>
    </div>
    <?php endif; ?>

    <div id="sync-loader" class="loader-overlay full-screen" style="display: none;">
        <div class="spinner" style="width: 40px; height: 40px;"></div>
        <span>Synchronisation vers Panoramax en cours...</span>
    </div>
<div tabindex="0" id="viewer-container">
    <div id="panorama"></div>

    <div id="crosshair">
        <div class="hline"></div>
        <div class="vline"></div>
    </div>

    <div id="filename"></div>
</div>

<div class="controls">
    <button id="prevBtn">Précédent</button>
    <button id="nextBtn">Suivant</button>
    <br /><br />
    <button id="Turn90m">-90</button>
    <button id="Turn0">0</button>
    <button id="resetView">Reset Vue</button>
    <button id="Turn90">+90</button>
    <button id="Turn180">+180</button>

    
    <form id="panoForm" method="POST">
      <div style="justify-content: center; display: flex; gap: 50px; font-family: sans-serif;">
        <!-- PITCH -->
        <div>
          <h3 style="text-align: center;">Pitch (<?= $pitch ?>)</h3>
          <div style="display: flex; gap: 5px;">
            <button type="submit" name="update_exif" value="pitch_minus_10">&#9650;&#9650;&#9650;</button>
            <button type="submit" name="update_exif" value="pitch_minus_5">&#9650;&#9650;</button>
            <button type="submit" name="update_exif" value="pitch_minus">&#9650;</button>
            <button id="pitch_fix" type="submit" name="update_exif" value="pitch_fix">FIX</button>
            <button type="submit" name="update_exif" value="pitch_reset">RESET</button>
            <button type="submit" name="update_exif" value="pitch_plus">&#9660;</button>
            <button type="submit" name="update_exif" value="pitch_plus_5">&#9660;&#9660;</button>
            <button type="submit" name="update_exif" value="pitch_plus_10">&#9660;&#9660;&#9660;</button>
          </div>
        </div>
  
        <!-- ROLL -->
        <div>
          <h3 style="text-align: center;">Roll (<?=$roll ?>)</h3>
          <div style="display: flex; gap: 5px;">
            <button type="submit" name="update_exif" value="roll_minus_10">&#8635;&#8635;&#8635;</button>
            <button type="submit" name="update_exif" value="roll_minus_5">&#8635;&#8635;</button>
            <button type="submit" name="update_exif" value="roll_minus">&#8635;</button>
            <button id="roll_fix" type="submit" name="update_exif" value="roll_fix">FIX</button>
            <button type="submit" name="update_exif" value="roll_reset">RESET</button>
            <button type="submit" name="update_exif" value="roll_plus">&#8634;</button>
            <button type="submit" name="update_exif" value="roll_plus_5">&#8634;&#8634;</button>
            <button type="submit" name="update_exif" value="roll_plus_10">&#8634;&#8634;&#8634;</button>
          </div>
        </div>
        <div>
         <h3 style="text-align: center;">Yaw (<?=$yaw ?>)</h3>
         <div style="display: flex; gap: 5px;">
           <button id="yaw_fix" type="submit" name="update_exif" value="yaw_fix">Fix heading</button>
           <?php if (isset($_ENV['PANORAMAX_URL']) && isset($_ENV['PANORAMAX_TOKEN'])): ?>
           <button id="sync_api" type="submit" name="sync_api" value="1" style="background-color: #4CAF50; color: white;" onclick="document.getElementById('sync-loader').style.display='flex';">Synchroniser vers Panoramax (V)</button>
           <?php if (isset($sync_result)) echo "<span style='margin-left: 10px; color: #4CAF50;'>$sync_result</span>"; ?>
           <?php endif; ?>
         </div>
        </div>
      </div>
    </form>

</div>

<script src="https://cdn.jsdelivr.net/npm/pannellum/build/pannellum.js"></script>
<script>
    const images = <?php echo json_encode($images); ?>;
    if (currentIndex < 0 || currentIndex >= images.length) currentIndex = 0;

    const filenameDiv = document.getElementById('filename');

    function showImage(index) {
        if (window.viewer) window.viewer.destroy();
        window.viewer = pannellum.viewer('panorama', {
            type: "equirectangular",
            panorama: images[index] + '?t=' + new Date().getTime(),
            autoLoad: true,
            pitch: currentPitch,
            yaw: currentYaw,
            hfov: currentHfov
        });

        document.getElementById('resetView').onclick = () => {
            window.viewer.setYaw(<?= $yaw ?>);
            window.viewer.setPitch(0);
            window.viewer.setHfov(120);
        };
        document.getElementById('Turn90').onclick = () => {
            window.viewer.setYaw(90);
            window.viewer.setPitch(0);
        };
        document.getElementById('Turn180').onclick = () => {
            window.viewer.setYaw(180);
            window.viewer.setPitch(0);
        };
        document.getElementById('Turn90m').onclick = () => {
            window.viewer.setYaw(-90);
            window.viewer.setPitch(0);
        };
        document.getElementById('Turn0').onclick = () => {
            window.viewer.setYaw(0);
            window.viewer.setPitch(0);
        };
        window.viewer.on('animatefinish', updateUrl);
        window.viewer.on('mouseup', updateUrl);
        window.viewer.on('touchend', updateUrl);
        //window.viewer.on('zoomchange', updateUrl);

        filenameDiv.textContent = images[index];
    }

    document.getElementById('prevBtn').onclick = () => {
        currentIndex = (currentIndex - 1 + images.length) % images.length;
        window.location.href = '?img=' + currentIndex;
    };
    document.getElementById('nextBtn').onclick = () => {
        currentIndex = (currentIndex + 1) % images.length;
        window.location.href = '?img=' + currentIndex;
    };

    const keyToButtonId = {
        "Numpad0": "resetView",
        "KeyX": "resetView",
        "PageUp": "prevBtn",
        "KeyZ": "prevBtn",
        "PageDown": "nextBtn",
        "KeyC": "nextBtn",
        "KeyW": "roll_fix",
        "KeyQ": "pitch_fix",
        "KeyE": "yaw_fix",
        "KeyA": "Turn90m",
        "KeyS": "Turn0",
        "KeyD": "Turn90",

    };
    document.addEventListener('keydown', e => {
        const boutonId = keyToButtonId[e.code];
        if (boutonId) {
            e.preventDefault();
            const bouton = document.getElementById(boutonId);
            if (bouton) bouton.click();
        }
    });

    document.getElementById('panoForm').onsubmit = function () {
        this.action = window.location.pathname + window.location.search;
    };

    function updateUrl() {
        const yaw = window.viewer.getYaw();
        const pitch = window.viewer.getPitch();
        const fov = window.viewer.getHfov();
        const newUrl = window.location.pathname +
            `?yaw=${yaw.toFixed(2)}&pitch=${pitch.toFixed(2)}&fov=${fov.toFixed(2)}&img=${currentIndex}`;
        history.replaceState(null, '', newUrl);
    }
    showImage(currentIndex);


</script>

</body>
</html>
