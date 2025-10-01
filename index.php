<?php
// --- Récupération des images ---
$images = array_merge(glob("images/*.jpg"), glob("images/*.JPG"), glob("images/*/*.JPG"));
natsort($images);
$images = array_values($images);
$img_current = isset($_GET['img']) ? (int)$_GET['img'] : 0;

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
?>
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>Visionneuse Pannellum</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/pannellum/build/pannellum.css"/>
    <style>
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

