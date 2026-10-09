<?php
// OPCIONAL. Copia aquest fitxer com a config.local.php (al costat de
// api.php) nomes si vols triar les contrasenyes inicials o la carpeta de
// dades. Si no hi es, les contrasenyes es generen a l'atzar i s'apunten
// a ~/ccmallorca-data/CONTRASENAS.txt.
//
// Les contrasenyes nomes s'usen la PRIMERA vegada (quan encara no existeix
// config.json); despres es canvien des del modo administrador.

$CCM = array(
    'password'       => 'contraseña-del-cliente',
    'admin_password' => 'tu-contraseña-de-administrador',
    // 'data_dir'    => '/home/USUARIO/ccmallorca-data',
);
