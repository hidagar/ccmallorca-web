<?php
// API de la web de CC Mallorca (editor tipus FrontPage), en PHP pla.
// Sense base de dades ni dependencies: funciona a qualsevol hosting amb
// cPanel (PHP 7.0 o superior) sense configurar res.
//
//   GET  api.php?r=content    -> contingut actual (content.json)
//   GET  api.php?r=session    -> { authenticated, role }
//   POST api.php?r=login      -> { password } -> { ok, role }
//   POST api.php?r=logout
//   PUT  api.php?r=content    -> el client (editor) guarda NOMES valors
//   PUT  api.php?r=structure  -> l'admin guarda l'estructura sencera
//   POST api.php?r=upload     -> multipart: file, kind=image|document -> { src }
//   POST api.php?r=password   -> (admin) { who: editor|admin, password }
//
// Dades privades (content.json, config.json, copies de seguretat) FORA de
// la carpeta publica: per defecte ~/ccmallorca-data. Les fotos i PDF van a
// uploads/ al costat d'aquest fitxer perque Apache les serveixi directament.

error_reporting(E_ALL);
ini_set('display_errors', '0');

$CCM = array();
if (is_file(__DIR__ . '/config.local.php')) {
    include __DIR__ . '/config.local.php';
}

define('UPLOADS_DIR', __DIR__ . '/uploads');
define('DATA_DIR', rtrim(!empty($CCM['data_dir']) ? $CCM['data_dir'] : default_data_dir(), '/'));
define('CONTENT_FILE', DATA_DIR . '/content.json');
define('CONFIG_FILE', DATA_DIR . '/config.json');
define('BACKUP_DIR', DATA_DIR . '/backups');
define('ATTEMPTS_FILE', DATA_DIR . '/intentos.json');

const PAGE_THEMES = array('oscuro', 'papel');
const GALLERY_LAYOUTS = array('fila', 'mosaico', 'mosaico-izquierda', 'rejilla');
const BLOCK_TYPES = array('heading', 'text', 'image', 'gallery', 'document');
const MAX_PAGES = 40;
const MAX_BLOCKS = 120;
const MAX_MENU = 40;
const ALLOWED_TAGS = array('p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'h3', 'h4', 'blockquote', 'a');

// El directori personal de l'usuari del hosting (/home/usuari): aixi les
// dades queden fora de qualsevol carpeta publica.
function default_data_dir()
{
    $home = getenv('HOME');
    if (!$home && function_exists('posix_getpwuid') && function_exists('posix_geteuid')) {
        $info = posix_getpwuid(posix_geteuid());
        $home = $info ? $info['dir'] : '';
    }
    if ($home && is_dir($home) && is_writable($home)) return $home . '/ccmallorca-data';
    return dirname(__DIR__) . '/ccmallorca-data';
}

// ----------------------------------------------------------------- utilitats

function send_json($code, $data, $headers = array())
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    foreach ($headers as $h) header($h, false);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail($code, $message)
{
    send_json($code, array('error' => $message));
}

function json_out($data)
{
    return json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
}

function read_json_file($file)
{
    $data = json_decode((string) @file_get_contents($file), true);
    return is_array($data) ? $data : null;
}

// Escriptura atomica: fitxer temporal + rename. Si el proces cau a mitges,
// el contingut del client no queda mai corromput.
function write_file_atomic($file, $text)
{
    $tmp = $file . '.tmp' . bin2hex(random_bytes(3));
    if (file_put_contents($tmp, $text) === false) throw new Exception('No se pudo escribir');
    @chmod($tmp, 0640);
    if (!rename($tmp, $file)) {
        @unlink($tmp);
        throw new Exception('No se pudo escribir');
    }
}

function cut($s, $n)
{
    if (function_exists('mb_substr')) return mb_substr($s, 0, $n, 'UTF-8');
    return preg_match('/^.{0,' . (int) $n . '}/su', $s, $m) ? $m[0] : substr($s, 0, $n);
}

function str($v)
{
    return is_string($v) ? $v : '';
}

function b64url_encode($bin)
{
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function b64url_decode($s)
{
    return base64_decode(strtr($s, '-_', '+/'));
}

function random_password()
{
    $chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $out = '';
    for ($i = 0; $i < 12; $i++) $out .= $chars[random_int(0, strlen($chars) - 1)];
    return $out;
}

// ------------------------------------------------------------------ neteja

function strip_tags_text($s)
{
    $s = preg_replace('/<(script|style)[\s\S]*?<\/\1>/i', '', (string) $s);
    $s = preg_replace('/<[^>]*>/', '', $s);
    $s = preg_replace('/\s+/u', ' ', $s);
    return trim((string) $s);
}

function clean_text($v, $max)
{
    return cut(strip_tags_text(str($v)), $max);
}

// Neteja l'HTML del text ric: nomes etiquetes segures, nomes href a <a>.
function sanitize_html($html)
{
    $out = preg_replace('/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/i', '', (string) $html);
    $out = preg_replace('/<!--[\s\S]*?-->/', '', $out);
    $out = preg_replace_callback('/<\/?([a-zA-Z0-9]+)([^>]*)>/', function ($m) {
        $t = strtolower($m[1]);
        if (!in_array($t, ALLOWED_TAGS, true)) return '';
        if (substr($m[0], 0, 2) === '</') return '</' . $t . '>';
        if ($t === 'br') return '<br>';
        if ($t === 'a') {
            $url = '';
            if (preg_match('/href\s*=\s*("([^"]*)"|\'([^\']*)\'|([^\s>]+))/i', $m[2], $h)) {
                $url = trim(isset($h[4]) && $h[4] !== '' ? $h[4] : (isset($h[3]) && $h[3] !== '' ? $h[3] : $h[2]));
            }
            if (!preg_match('/^(https?:\/\/|mailto:|#|\/|\.\/)/i', $url)) $url = '';
            return $url !== ''
                ? '<a href="' . htmlspecialchars($url, ENT_QUOTES, 'UTF-8') . '" target="_blank" rel="noopener noreferrer">'
                : '<a>';
        }
        return '<' . $t . '>';
    }, $out);
    return trim((string) $out);
}

// Nomes acceptem fotos pujades, imatges incloses o URLs https.
function is_safe_src($src)
{
    if (!is_string($src) || $src === '') return false;
    if (strpos($src, '..') !== false || strpos($src, '\\') !== false) return false;
    return (bool) (preg_match('/^uploads\/[\w.\-]+$/', $src)
        || preg_match('/^img\/[\w.\-\/]+$/', $src)
        || preg_match('/^https:\/\/[^\s"\'<>]+$/', $src));
}

// Proporcio ample/alt d'una foto (la calcula el navegador en pujar-la).
function clean_ratio($r)
{
    if (!is_numeric($r)) return null;
    $n = (float) $r;
    return ($n >= 0.1 && $n <= 10) ? round($n, 3) : null;
}

function clean_image($im)
{
    $out = array(
        'src' => $im['src'],
        'alt' => clean_text(isset($im['alt']) ? $im['alt'] : '', 300),
        'caption' => clean_text(isset($im['caption']) ? $im['caption'] : '', 300),
        'credit' => clean_text(isset($im['credit']) ? $im['credit'] : '', 120),
    );
    $ratio = clean_ratio(isset($im['ratio']) ? $im['ratio'] : null);
    if ($ratio) $out['ratio'] = $ratio;
    return $out;
}

function clean_images($list)
{
    $out = array();
    if (!is_array($list)) return $out;
    foreach ($list as $im) {
        if (count($out) >= 80) break;
        if (is_array($im) && isset($im['src']) && is_safe_src($im['src'])) $out[] = clean_image($im);
    }
    return $out;
}

function slugify($s)
{
    $s = (string) $s;
    if (class_exists('Normalizer')) {
        $s = preg_replace('/\p{Mn}+/u', '', Normalizer::normalize($s, Normalizer::FORM_D));
    } else {
        $s = strtr($s, array(
            'á' => 'a', 'à' => 'a', 'ä' => 'a', 'â' => 'a', 'Á' => 'a', 'À' => 'a',
            'é' => 'e', 'è' => 'e', 'ë' => 'e', 'ê' => 'e', 'É' => 'e', 'È' => 'e',
            'í' => 'i', 'ì' => 'i', 'ï' => 'i', 'î' => 'i', 'Í' => 'i', 'Ì' => 'i',
            'ó' => 'o', 'ò' => 'o', 'ö' => 'o', 'ô' => 'o', 'Ó' => 'o', 'Ò' => 'o',
            'ú' => 'u', 'ù' => 'u', 'ü' => 'u', 'û' => 'u', 'Ú' => 'u', 'Ù' => 'u',
            'ñ' => 'n', 'Ñ' => 'n', 'ç' => 'c', 'Ç' => 'c', 'l·l' => 'll',
        ));
    }
    $s = strtolower($s);
    $s = preg_replace('/[^a-z0-9]+/', '-', $s);
    return substr(trim($s, '-'), 0, 48);
}

// ------------------------------------------------------------ dades i config

function ensure_data()
{
    global $CCM;
    foreach (array(DATA_DIR, BACKUP_DIR, UPLOADS_DIR) as $dir) {
        if (!is_dir($dir) && !@mkdir($dir, 0750, true)) {
            fail(500, 'No se puede crear la carpeta de datos: ' . $dir);
        }
    }
    // Si per error la carpeta de dades queda dins d'una carpeta publica,
    // que Apache no la serveixi mai.
    if (!is_file(DATA_DIR . '/.htaccess')) @file_put_contents(DATA_DIR . '/.htaccess', "Require all denied\nDeny from all\n");
    if (!is_file(DATA_DIR . '/index.html')) @file_put_contents(DATA_DIR . '/index.html', '');
    if (!is_file(UPLOADS_DIR . '/index.html')) @file_put_contents(UPLOADS_DIR . '/index.html', '');

    $defaultsFile = defaults_file();
    if (!is_file(CONTENT_FILE)) {
        if (!$defaultsFile) fail(500, 'Falta content.default.json');
        write_file_atomic(CONTENT_FILE, file_get_contents($defaultsFile));
    }

    $cfg = read_json_file(CONFIG_FILE);
    if (!$cfg || empty($cfg['editorHash']) || empty($cfg['adminHash'])) {
        $editor = !empty($CCM['password']) ? $CCM['password'] : random_password();
        $admin = !empty($CCM['admin_password']) ? $CCM['admin_password'] : random_password();
        $cfg = array(
            'secret' => bin2hex(random_bytes(32)),
            'editorHash' => password_hash($editor, PASSWORD_DEFAULT),
            'adminHash' => password_hash($admin, PASSWORD_DEFAULT),
        );
        write_file_atomic(CONFIG_FILE, json_out($cfg));
        // Primera instal·lacio: les contrasenyes queden apuntades a la
        // carpeta de dades (fora de la web) perque l'admin les pugui llegir
        // des del Administrador de archivos de cPanel.
        @file_put_contents(DATA_DIR . '/CONTRASENAS.txt',
            "Contraseñas iniciales de la web (cámbialas desde el modo administrador y borra este archivo)\n\n"
            . "Cliente (edita textos y fotos): $editor\n"
            . "Administrador (estructura):     $admin\n");
    }

    // Si content.default.json ha canviat (desplegament nou), afegim al
    // contingut del client les pagines/blocs nous que li faltin.
    if ($defaultsFile) {
        $hash = md5_file($defaultsFile);
        if (!isset($cfg['defaultsHash']) || $cfg['defaultsHash'] !== $hash) {
            $defaults = read_json_file($defaultsFile);
            $current = read_json_file(CONTENT_FILE);
            if ($defaults && $current && sync_structure($current, $defaults)) save_content($current);
            $cfg['defaultsHash'] = $hash;
            write_file_atomic(CONFIG_FILE, json_out($cfg));
        }
    }
    return $cfg;
}

function defaults_file()
{
    foreach (array(__DIR__ . '/content.default.json', dirname(__DIR__) . '/content.default.json') as $f) {
        if (is_file($f)) return $f;
    }
    return null;
}

function load_content()
{
    $c = read_json_file(CONTENT_FILE);
    if (!$c) fail(500, 'El contenido está dañado; restaura una copia de seguridad');
    return $c;
}

function save_content($content)
{
    // Copia de seguretat de l'anterior (es conserven les 30 ultimes)
    if (is_file(CONTENT_FILE)) {
        @copy(CONTENT_FILE, BACKUP_DIR . '/content-' . gmdate('Y-m-d\TH-i-s') . '-' . bin2hex(random_bytes(2)) . '.json');
        $files = glob(BACKUP_DIR . '/content-*.json');
        if ($files && count($files) > 30) {
            sort($files);
            foreach (array_slice($files, 0, count($files) - 30) as $old) @unlink($old);
        }
    }
    write_file_atomic(CONTENT_FILE, json_out($content));
}

// --------------------------------------------------------------- sessio

function make_token($secret, $role)
{
    $payload = b64url_encode(json_encode(array('exp' => (time() + 12 * 3600) * 1000, 'role' => $role)));
    return $payload . '.' . b64url_encode(hash_hmac('sha256', $payload, $secret, true));
}

function token_role($token, $secret)
{
    if (!is_string($token) || strpos($token, '.') === false) return null;
    list($payload, $sig) = explode('.', $token, 2);
    $expected = b64url_encode(hash_hmac('sha256', $payload, $secret, true));
    if (!hash_equals($expected, $sig)) return null;
    $data = json_decode((string) b64url_decode($payload), true);
    if (!is_array($data) || !isset($data['exp']) || $data['exp'] <= time() * 1000) return null;
    return (isset($data['role']) && $data['role'] === 'admin') ? 'admin' : 'editor';
}

function role_of($cfg)
{
    return token_role(isset($_COOKIE['ccm_session']) ? $_COOKIE['ccm_session'] : null, $cfg['secret']);
}

function session_cookie($value, $maxAge)
{
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');
    return 'Set-Cookie: ccm_session=' . $value . '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' . $maxAge
        . ($secure ? '; Secure' : '');
}

// Limit d'intents de contrasenya per IP (10 cada 15 minuts)
function attempts_update($ip, $mode)
{
    $fp = fopen(ATTEMPTS_FILE, 'c+');
    if (!$fp) return false;
    flock($fp, LOCK_EX);
    $all = json_decode((string) stream_get_contents($fp), true);
    if (!is_array($all)) $all = array();
    $now = time();
    foreach ($all as $k => $rec) {
        if ($now - $rec['first'] > 900) unset($all[$k]);
    }
    $blocked = isset($all[$ip]) && $all[$ip]['count'] >= 10;
    if ($mode === 'fail') {
        if (!isset($all[$ip])) $all[$ip] = array('first' => $now, 'count' => 0);
        $all[$ip]['count']++;
    } elseif ($mode === 'ok') {
        unset($all[$ip]);
    }
    if ($mode !== 'check') {
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($all));
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    return $blocked;
}

// ---------------------------------------------- fusio segura (client)
// Nomes s'actualitzen VALORS de blocs que ja existeixen: el client pot
// canviar textos i fotos pero no pot trencar l'estructura de la web.

function merge_content($current, $incoming)
{
    $out = $current;

    if (isset($incoming['site']) && is_array($incoming['site'])) {
        foreach (array('title', 'subtitle', 'footer', 'email', 'telefon', 'adreca') as $key) {
            if (isset($incoming['site'][$key]) && is_string($incoming['site'][$key])) {
                $out['site'][$key] = clean_text($incoming['site'][$key], 300);
            }
        }
    }

    $pages = (isset($incoming['pages']) && is_array($incoming['pages'])) ? $incoming['pages'] : array();
    foreach ($pages as $slug => $page) {
        if (!is_array($page) || !isset($out['pages'][$slug])) continue;
        $target = &$out['pages'][$slug];

        if (isset($page['title']) && is_string($page['title'])) $target['title'] = clean_text($page['title'], 200);
        if (isset($page['intro']) && is_string($page['intro'])) $target['intro'] = sanitize_html($page['intro']);

        // La FOTO de capçalera, nomes si l'admin ja l'ha creada
        if (isset($target['header']) && isset($page['header']) && is_array($page['header'])) {
            if (isset($page['header']['src']) && is_safe_src($page['header']['src'])) $target['header']['src'] = $page['header']['src'];
            if (isset($page['header']['alt']) && is_string($page['header']['alt'])) $target['header']['alt'] = clean_text($page['header']['alt'], 300);
        }

        $blocksIn = (isset($page['blocks']) && is_array($page['blocks'])) ? $page['blocks'] : array();
        if (!isset($target['blocks']) || !is_array($target['blocks'])) $blocksIn = array();
        foreach ($blocksIn as $block) {
            if (!is_array($block) || !isset($block['id'])) continue;
            foreach ($target['blocks'] as &$dest) {
                if (!isset($dest['id']) || $dest['id'] !== $block['id']) continue;
                $type = $dest['type'];
                if ($type === 'heading' && isset($block['text']) && is_string($block['text'])) {
                    $dest['text'] = clean_text($block['text'], 200);
                }
                if ($type === 'text' && isset($block['html']) && is_string($block['html'])) {
                    $dest['html'] = sanitize_html($block['html']);
                }
                if ($type === 'image') {
                    $prevSrc = isset($dest['src']) ? $dest['src'] : '';
                    // '' = el client ha tret la foto
                    if (isset($block['src']) && (is_safe_src($block['src']) || $block['src'] === '')) $dest['src'] = $block['src'];
                    foreach (array('alt' => 300, 'caption' => 300, 'credit' => 120) as $k => $max) {
                        if (isset($block[$k]) && is_string($block[$k])) $dest[$k] = clean_text($block[$k], $max);
                    }
                    $ratio = clean_ratio(isset($block['ratio']) ? $block['ratio'] : null);
                    if ($ratio) $dest['ratio'] = $ratio;
                    elseif ($dest['src'] !== $prevSrc || !$dest['src']) unset($dest['ratio']);
                }
                if ($type === 'document') {
                    if (isset($block['src']) && (is_safe_src($block['src']) || $block['src'] === '')) $dest['src'] = $block['src'];
                    if (isset($block['label']) && is_string($block['label'])) $dest['label'] = clean_text($block['label'], 200);
                }
                if ($type === 'gallery' && isset($block['images']) && is_array($block['images'])) {
                    $dest['images'] = clean_images($block['images']);
                }
                break;
            }
            unset($dest);
        }
        unset($target);
    }
    return $out;
}

// ------------------------------------------- estructura (nomes admin)
// L'admin SI pot canviar l'estructura, pero no ens en refiem: reconstruim
// el contingut des de zero amb nomes els camps permesos i tot sanejat.

function make_id($prefix, &$used)
{
    $base = substr(slugify(strip_tags_text($prefix)), 0, 32);
    if ($base === '' || $base === false) $base = 'bloc';
    $id = $base;
    $n = 2;
    while (isset($used[$id])) $id = $base . '-' . $n++;
    $used[$id] = true;
    return $id;
}

function with_layout($block, $raw)
{
    if (isset($raw['width']) && $raw['width'] === 'half') $block['width'] = 'half';
    return $block;
}

function sanitize_block($raw, &$used)
{
    if (!is_array($raw) || !isset($raw['type']) || !in_array($raw['type'], BLOCK_TYPES, true)) return null;
    $type = $raw['type'];
    if (isset($raw['id']) && is_string($raw['id']) && preg_match('/^[\w-]{1,80}$/', $raw['id']) && !isset($used[$raw['id']])) {
        $id = $raw['id'];
        $used[$id] = true;
    } else {
        $id = make_id($type . '-' . str(isset($raw['text']) ? $raw['text'] : (isset($raw['label']) ? $raw['label'] : '')), $used);
    }
    $g = function ($k) use ($raw) { return isset($raw[$k]) ? $raw[$k] : ''; };

    if ($type === 'heading') return with_layout(array('id' => $id, 'type' => 'heading', 'text' => clean_text($g('text'), 200)), $raw);
    if ($type === 'text') return with_layout(array('id' => $id, 'type' => 'text', 'html' => sanitize_html(str($g('html')))), $raw);
    if ($type === 'image') {
        $src = is_safe_src($g('src')) ? $g('src') : '';
        $b = array('id' => $id, 'type' => 'image', 'src' => $src);
        $ratio = clean_ratio($g('ratio'));
        if ($ratio && $src) $b['ratio'] = $ratio;
        $b['alt'] = clean_text($g('alt'), 300);
        $b['caption'] = clean_text($g('caption'), 300);
        $b['credit'] = clean_text($g('credit'), 120);
        return with_layout($b, $raw);
    }
    if ($type === 'document') {
        return with_layout(array(
            'id' => $id, 'type' => 'document',
            'src' => is_safe_src($g('src')) ? $g('src') : '',
            'label' => clean_text($g('label'), 200),
        ), $raw);
    }
    // gallery
    $b = array('id' => $id, 'type' => 'gallery', 'images' => clean_images($g('images')));
    if (in_array($g('layout'), GALLERY_LAYOUTS, true)) $b['layout'] = $g('layout');
    return with_layout($b, $raw);
}

function sanitize_structure($incoming)
{
    if (!is_array($incoming)) throw new Exception('Estructura no válida');
    $out = array('site' => array(), 'menu' => array(), 'pages' => array());

    $site = (isset($incoming['site']) && is_array($incoming['site'])) ? $incoming['site'] : array();
    foreach (array('title', 'subtitle', 'footer', 'email', 'telefon', 'adreca') as $key) {
        $out['site'][$key] = clean_text(isset($site[$key]) ? $site[$key] : '', 300);
    }

    $pagesIn = (isset($incoming['pages']) && is_array($incoming['pages'])) ? $incoming['pages'] : array();
    if (count($pagesIn) > MAX_PAGES) throw new Exception('Demasiadas páginas');
    $usedSlugs = array();
    foreach ($pagesIn as $rawSlug => $page) {
        if (!is_array($page)) $page = array();
        $slug = preg_match('/^[a-z0-9-]{1,48}$/', (string) $rawSlug) ? (string) $rawSlug : slugify($rawSlug);
        if ($slug === '') continue;
        if (isset($usedSlugs[$slug])) {
            $n = 2;
            while (isset($usedSlugs[$slug . '-' . $n])) $n++;
            $slug = $slug . '-' . $n;
        }
        $usedSlugs[$slug] = true;

        $used = array();
        $blocks = array();
        $blocksIn = (isset($page['blocks']) && is_array($page['blocks'])) ? array_slice($page['blocks'], 0, MAX_BLOCKS) : array();
        foreach ($blocksIn as $b) {
            $sb = sanitize_block($b, $used);
            if ($sb) $blocks[] = $sb;
        }
        $outPage = array(
            'title' => clean_text(isset($page['title']) ? $page['title'] : '', 200),
            'intro' => sanitize_html(str(isset($page['intro']) ? $page['intro'] : '')),
            'blocks' => $blocks,
        );
        if (isset($page['theme']) && in_array($page['theme'], PAGE_THEMES, true)) $outPage['theme'] = $page['theme'];
        if (isset($page['header']['src']) && is_safe_src($page['header']['src'])) {
            $outPage['header'] = array(
                'src' => $page['header']['src'],
                'alt' => clean_text(isset($page['header']['alt']) ? $page['header']['alt'] : '', 300),
            );
        }
        $out['pages'][$slug] = $outPage;
    }

    // Menu: nomes entrades a pagines existents; cap pagina queda orfe
    $menuIn = (isset($incoming['menu']) && is_array($incoming['menu'])) ? array_slice($incoming['menu'], 0, MAX_MENU) : array();
    $seen = array();
    foreach ($menuIn as $m) {
        if (!is_array($m) || !isset($m['slug']) || !is_string($m['slug'])) continue;
        $s = $m['slug'];
        if (!isset($out['pages'][$s]) || isset($seen[$s])) continue;
        $seen[$s] = true;
        $label = clean_text(isset($m['label']) && $m['label'] !== '' ? $m['label'] : ($out['pages'][$s]['title'] ?: $s), 60);
        $out['menu'][] = array('slug' => $s, 'label' => $label);
    }
    foreach ($out['pages'] as $s => $p) {
        if (!isset($seen[$s])) $out['menu'][] = array('slug' => (string) $s, 'label' => cut($p['title'] ?: (string) $s, 60));
    }

    if (!count($out['pages'])) throw new Exception('La web necesita al menos una página');
    return $out;
}

// Afegeix al contingut del client tot allo del default que li falti
// (pagines, blocs, entrades de menu), sense tocar ni esborrar res seu.
function sync_structure(&$current, $defaults)
{
    $changed = false;
    if (!isset($current['menu']) || !is_array($current['menu'])) { $current['menu'] = array(); $changed = true; }
    $at = 0;
    foreach ((isset($defaults['menu']) ? $defaults['menu'] : array()) as $item) {
        $idx = -1;
        foreach ($current['menu'] as $i => $m) if (isset($m['slug']) && $m['slug'] === $item['slug']) { $idx = $i; break; }
        if ($idx === -1) {
            array_splice($current['menu'], $at, 0, array($item));
            $at++;
            $changed = true;
        } else {
            $at = $idx + 1;
        }
    }

    if (!isset($current['pages']) || !is_array($current['pages'])) { $current['pages'] = array(); $changed = true; }
    foreach ((isset($defaults['pages']) ? $defaults['pages'] : array()) as $slug => $defPage) {
        if (!isset($current['pages'][$slug])) {
            $current['pages'][$slug] = $defPage;
            $changed = true;
            continue;
        }
        $cur = &$current['pages'][$slug];
        if (!isset($cur['blocks']) || !is_array($cur['blocks'])) { $cur['blocks'] = array(); $changed = true; }
        if (!empty($defPage['theme']) && empty($cur['theme'])) { $cur['theme'] = $defPage['theme']; $changed = true; }
        $at = 0;
        foreach ((isset($defPage['blocks']) ? $defPage['blocks'] : array()) as $defBlock) {
            $idx = -1;
            foreach ($cur['blocks'] as $i => $b) if (isset($b['id']) && $b['id'] === $defBlock['id']) { $idx = $i; break; }
            if ($idx === -1) {
                array_splice($cur['blocks'], $at, 0, array($defBlock));
                $at++;
                $changed = true;
            } else {
                $at = $idx + 1;
            }
        }
        unset($cur);
    }
    return $changed;
}

// ------------------------------------------------------------------ pujades

function upload_error_message($code, $isDoc)
{
    if ($code === UPLOAD_ERR_INI_SIZE || $code === UPLOAD_ERR_FORM_SIZE) {
        return $isDoc ? 'El PDF es demasiado grande para el servidor' : 'La foto es demasiado grande para el servidor';
    }
    if ($code === UPLOAD_ERR_NO_FILE) return 'Falta el archivo';
    return 'No se pudo subir el archivo (error ' . $code . ')';
}

function handle_upload()
{
    $isDoc = isset($_POST['kind']) && $_POST['kind'] === 'document';
    if (!isset($_FILES['file'])) fail(400, 'Falta el archivo');
    $f = $_FILES['file'];
    if ($f['error'] !== UPLOAD_ERR_OK) fail(400, upload_error_message($f['error'], $isDoc));

    $max = $isDoc ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
    if ($f['size'] > $max) fail(400, $isDoc ? 'El PDF es demasiado grande (máximo 20 MB)' : 'La foto es demasiado grande (máximo 8 MB)');
    if ($f['size'] < 12) fail(400, 'El archivo no es válido');

    // Comprovem el contingut real, no el nom ni el tipus que diu el navegador
    $head = (string) file_get_contents($f['tmp_name'], false, null, 0, 1024);
    $ext = null;
    if ($isDoc) {
        if (strpos($head, '%PDF-') !== false) $ext = '.pdf';
    } else {
        if (substr($head, 0, 3) === "\xFF\xD8\xFF") $ext = '.jpg';
        elseif (substr($head, 0, 4) === "\x89PNG") $ext = '.png';
        elseif (substr($head, 0, 3) === 'GIF') $ext = '.gif';
        elseif (substr($head, 0, 4) === 'RIFF' && substr($head, 8, 4) === 'WEBP') $ext = '.webp';
    }
    if (!$ext) fail(400, $isDoc ? 'El archivo no parece un PDF válido' : 'Solo se aceptan fotos JPG, PNG, GIF o WEBP');

    $name = isset($_POST['name']) && is_string($_POST['name']) ? $_POST['name'] : $f['name'];
    $base = trim(substr(slugify(preg_replace('/\.[A-Za-z0-9]+$/', '', strip_tags_text($name))), 0, 40), '-');
    if ($base === '' || $base === false) $base = $isDoc ? 'documento' : 'foto';
    $filename = $base . '-' . bin2hex(random_bytes(4)) . $ext;

    if (!move_uploaded_file($f['tmp_name'], UPLOADS_DIR . '/' . $filename)) fail(500, 'No se pudo guardar el archivo');
    @chmod(UPLOADS_DIR . '/' . $filename, 0644);
    send_json(200, array('src' => 'uploads/' . $filename));
}

function read_body()
{
    $raw = file_get_contents('php://input');
    if (strlen($raw) > 5 * 1024 * 1024) fail(413, 'El contenido es demasiado grande');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : array();
}

function client_ip()
{
    return isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
}

// --------------------------------------------------------------------- rutes

try {
    $cfg = ensure_data();
    $route = isset($_GET['r']) ? (string) $_GET['r'] : '';
    $method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';

    // Si la peticio supera post_max_size, PHP buida $_POST i $_FILES sense dir res
    if ($method === 'POST' && empty($_FILES) && empty($_POST) && $route === 'upload'
        && isset($_SERVER['CONTENT_LENGTH']) && (int) $_SERVER['CONTENT_LENGTH'] > 0) {
        fail(413, 'El archivo es demasiado grande para el servidor');
    }

    if ($route === 'content' && $method === 'GET') {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-cache');
        readfile(CONTENT_FILE);
        exit;
    }

    if ($route === 'session') {
        $role = role_of($cfg);
        send_json(200, array('authenticated' => (bool) $role, 'role' => $role));
    }

    if ($route === 'login' && $method === 'POST') {
        $ip = client_ip();
        if (attempts_update($ip, 'check')) fail(429, 'Demasiados intentos. Espera unos minutos.');
        $body = read_body();
        $given = isset($body['password']) && is_string($body['password']) ? $body['password'] : '';
        $role = null;
        if ($given !== '' && password_verify($given, $cfg['adminHash'])) $role = 'admin';
        elseif ($given !== '' && password_verify($given, $cfg['editorHash'])) $role = 'editor';
        if (!$role) {
            attempts_update($ip, 'fail');
            fail(401, 'La contraseña no es correcta');
        }
        attempts_update($ip, 'ok');
        send_json(200, array('ok' => true, 'role' => $role), array(session_cookie(make_token($cfg['secret'], $role), 43200)));
    }

    if ($route === 'logout' && $method === 'POST') {
        send_json(200, array('ok' => true), array(session_cookie('', 0)));
    }

    $role = role_of($cfg);

    if ($route === 'content' && $method === 'PUT') {
        if (!$role) fail(401, 'Tienes que iniciar sesión otra vez');
        $merged = merge_content(load_content(), read_body());
        save_content($merged);
        send_json(200, array('ok' => true, 'content' => $merged));
    }

    if ($route === 'structure' && $method === 'PUT') {
        if ($role !== 'admin') fail(403, 'Solo el administrador puede cambiar la estructura');
        try {
            $saved = sanitize_structure(read_body());
        } catch (Exception $e) {
            fail(400, $e->getMessage());
        }
        save_content($saved);
        send_json(200, array('ok' => true, 'content' => $saved));
    }

    if ($route === 'upload' && $method === 'POST') {
        if (!$role) fail(401, 'Tienes que iniciar sesión otra vez');
        handle_upload();
    }

    if ($route === 'password' && $method === 'POST') {
        if ($role !== 'admin') fail(403, 'Solo el administrador puede cambiar las contraseñas');
        $body = read_body();
        $who = isset($body['who']) && $body['who'] === 'admin' ? 'admin' : 'editor';
        $pw = isset($body['password']) && is_string($body['password']) ? $body['password'] : '';
        if (strlen($pw) < 6) fail(400, 'La contraseña debe tener al menos 6 caracteres');
        $cfg[$who === 'admin' ? 'adminHash' : 'editorHash'] = password_hash($pw, PASSWORD_DEFAULT);
        write_file_atomic(CONFIG_FILE, json_out($cfg));
        // Que el fitxer de contrasenyes inicials no enganyi: marquem la canviada
        $notes = DATA_DIR . '/CONTRASENAS.txt';
        if (is_file($notes)) {
            $label = $who === 'admin' ? 'Administrador' : 'Cliente';
            $text = preg_replace('/^(' . $label . '[^:]*:\s*).*$/m', '${1}(cambiada desde la web)', (string) file_get_contents($notes));
            @file_put_contents($notes, $text);
        }
        send_json(200, array('ok' => true));
    }

    fail(404, 'Ruta no encontrada');
} catch (Exception $e) {
    fail(500, 'Error del servidor');
}
