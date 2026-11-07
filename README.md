# PDF pour Desktroo

Lire, annoter, remplir, signer et modifier les PDF du NAS dans une fenêtre de Desktroo, installé depuis Desktroo Apps, les apps de [Desktroo](https://desktroo.fr).

- **Éditeur** : la version web officielle de [PdfCraft](https://github.com/storytold/pdfcraft) (logiciel libre, MIT OR Apache-2.0), téléchargée au build depuis sa publication GitHub, vérifiée par son empreinte SHA-256 et servie **sans modification** sous `/engine/`. Ses fichiers LICENSE-MIT, LICENSE-APACHE et NOTICE sont livrés avec lui dans l'image (`/app/engine/`). Le nom et les logos ArtCraft ne figurent ni dans le nom, ni dans l'icône, ni dans la fiche de l'app.
- **Fichiers du NAS** : l'app déclare `nas_access` en lecture-écriture. L'administrateur choisit dans Desktroo Apps le compte du NAS prêté à l'app et les dossiers ; ils sont montés sous `/nas/<nom>` (variable `DESKTROO_NAS`). Un dossier peut être imposé en lecture seule.
- **Fonctionnement** : la page de l'app (`public/index.html`) liste les PDF des dossiers confiés et encadre l'éditeur (`engine/index.html?host=parent`). Elle lui passe un fichier par le message `pdfcraft:open` et reçoit ses enregistrements par `pdfcraft:save` (contrat `craft-web-host`, même origine). Enregistrer remplace le fichier d'origine ; « Enregistrer sous » ou un fichier venu d'un dossier en lecture seule demande un nom, dans le dossier affiché à gauche.
- **Écriture sûre** : fichier temporaire dans le même dossier puis remplacement (un enregistrement coupé ne laisse jamais un PDF à moitié écrit) ; seuls des fichiers `.pdf` commençant par `%PDF-` sont acceptés ; 512 Mo au plus ; chemins confinés aux dossiers confiés, liens symboliques compris.
- **Accès** : toute requête sans le secret posé par Desktroo est refusée (`/healthz` excepté). Chaque ouverture et chaque enregistrement est journalisé avec l'utilisateur Desktroo.

## Mettre à jour PdfCraft

Changer `PDFCRAFT_VERSION` et `PDFCRAFT_SHA256` dans le `Dockerfile` (empreinte de `pdfcraft-web-<version>.zip` dans `SHA256SUMS.txt` de la publication), puis publier une version de l'app.

## Essai local

`test/harness.js` imite le bureau (préfixe `/a/pdf/`, en-têtes d'identité) ; `test/e2e.py` ouvre un PDF et l'enregistre avec Ctrl+S dans Chrome sans écran.

## Publier une version

`powershell -ExecutionPolicy Bypass -File publish-app.ps1 pdf 0.1.0 "première version"` depuis le dépôt Desktroo.

© 2026 Mdm-services.fr. Tous droits réservés. PdfCraft : © ArtCraft Team et contributeurs, MIT OR Apache-2.0.
