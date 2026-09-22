#!/bin/bash
set -e
# launchpad macOS build → sign (Developer ID) → notarize → DMG.
# Generated from a launchpad template; re-run /launchpad:setup to regenerate. Do not hand-edit.

APP_NAME="{{APP_NAME}}"
SCHEME="{{SCHEME}}"
XCODEPROJ="{{XCODEPROJ}}"
DMG_VOLNAME="${APP_NAME} Installer"
VERSION="${VERSION:-dev}"
OUT_DMG="${APP_NAME}-${VERSION}.dmg"

DEVELOPER_ID_CERT="${DEVELOPER_ID_CERT:-}"
APPLE_ID="${APPLE_ID:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
APPLE_APP_PASSWORD="${APPLE_APP_PASSWORD:-}"

{{PREBUILD}}

echo "Building ${APP_NAME} (${SCHEME})..."
xcodebuild -project "${XCODEPROJ}" -scheme "${SCHEME}" -configuration Release \
  -derivedDataPath ./build -skipMacroValidation \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO

APP_PATH="./build/Build/Products/Release/${APP_NAME}.app"
[ -d "${APP_PATH}" ] || { echo "Build failed - ${APP_PATH} not found"; exit 1; }

echo "Clearing extended attributes..."
xattr -cr "${APP_PATH}" 2>/dev/null || true

if [ -z "${DEVELOPER_ID_CERT}" ]; then
  echo "Ad-hoc signing (cannot notarize)"
  SIGN_IDENTITY="-"; NOTARIZE=false
else
  SIGN_IDENTITY="${DEVELOPER_ID_CERT}"; NOTARIZE=true
fi

if [ "${NOTARIZE}" = true ]; then
  # Sign inner -> outer, never --deep (causes CI hangs).
  if [ -d "${APP_PATH}/Contents/Frameworks/Sparkle.framework" ]; then
    find "${APP_PATH}/Contents/Frameworks/Sparkle.framework" -name "*.xpc" -print0 \
      | while IFS= read -r -d '' x; do codesign --force --sign "${SIGN_IDENTITY}" --options runtime --timestamp "$x"; done
    find "${APP_PATH}/Contents/Frameworks/Sparkle.framework" -name "*.app" -print0 \
      | while IFS= read -r -d '' a; do codesign --force --sign "${SIGN_IDENTITY}" --options runtime --timestamp "$a"; done
    [ -f "${APP_PATH}/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate" ] \
      && codesign --force --sign "${SIGN_IDENTITY}" --options runtime --timestamp \
         "${APP_PATH}/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate"
    codesign --force --sign "${SIGN_IDENTITY}" --options runtime --timestamp \
      "${APP_PATH}/Contents/Frameworks/Sparkle.framework"
  fi
  if [ -d "${APP_PATH}/Contents/Frameworks" ]; then
    find "${APP_PATH}/Contents/Frameworks" -maxdepth 1 -name "*.framework" ! -name "Sparkle.framework" -print0 \
      | while IFS= read -r -d '' fw; do codesign --force --sign "${SIGN_IDENTITY}" --options runtime --timestamp "$fw"; done
  fi
  codesign --force --sign "${SIGN_IDENTITY}" --options runtime --timestamp "${APP_PATH}"
else
  codesign --force --sign "${SIGN_IDENTITY}" "${APP_PATH}"
fi

echo "Verifying signature..."
codesign -dvvv "${APP_PATH}"

# Notarize + staple the .app BEFORE building the DMG, so the DMG ships a STAPLED
# app. A stapled app launches cleanly even offline — end users never hit a
# Gatekeeper "unidentified developer" / Privacy & Security override. The DMG is
# then notarized + stapled too, so the downloaded disk image opens without warning.
if [ "${NOTARIZE}" = true ]; then
  { [ -n "${APPLE_ID}" ] && [ -n "${APPLE_TEAM_ID}" ] && [ -n "${APPLE_APP_PASSWORD}" ]; } \
    || { echo "Notarization credentials missing"; exit 1; }
  echo "Notarizing the app bundle..."
  ditto -c -k --keepParent "${APP_PATH}" notarize-app.zip
  xcrun notarytool submit notarize-app.zip --apple-id "${APPLE_ID}" --team-id "${APPLE_TEAM_ID}" --password "${APPLE_APP_PASSWORD}" --wait
  rm -f notarize-app.zip
  xcrun stapler staple "${APP_PATH}"
fi

rm -f "${OUT_DMG}" tmp.dmg
hdiutil detach "/Volumes/${DMG_VOLNAME}" 2>/dev/null || true
hdiutil create -volname "${DMG_VOLNAME}" -srcfolder "${APP_PATH}" -ov -format UDRW tmp.dmg
MOUNT_DIR=$(hdiutil attach tmp.dmg -nobrowse -noverify | grep Volumes | sed 's/.*\/Volumes/\/Volumes/')
ln -s /Applications "${MOUNT_DIR}/Applications"
hdiutil detach "${MOUNT_DIR}" -quiet
hdiutil convert tmp.dmg -format UDZO -o "${OUT_DMG}"
rm tmp.dmg

if [ "${NOTARIZE}" = true ]; then
  echo "Notarizing ${OUT_DMG}..."
  xcrun notarytool submit "${OUT_DMG}" --apple-id "${APPLE_ID}" --team-id "${APPLE_TEAM_ID}" --password "${APPLE_APP_PASSWORD}" --wait
  xcrun stapler staple "${OUT_DMG}"
fi

echo "Done: ${OUT_DMG} ($(du -h "${OUT_DMG}" | cut -f1))"
