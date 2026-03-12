// NOTE: All paths are relative to the package.json that will be loading this configuration file.
// Making them relative to the scripts folder will break the commands
const isUnsignedBuild = process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false";

module.exports = {
    "productName": "BlueBubbles",
    "appId": "com.BlueBubbles.BlueBubbles-Server",
    "npmRebuild": true,
    "directories": {
        "output": "releases",
        "buildResources": "appResources"
    },
    "asar": true,
    "extraResources": [
        "appResources"
    ],
    "mac": {
        "category": "public.app-category.social-networking",
        "target": [
            {
                "target": "dmg",
                "arch": [
                    "x64",
                    "arm64"
                ],
            }
        ],
        "icon": "../../icons/macos/dock-icon.png",
        "darkModeSupport": true,
        "hardenedRuntime": !isUnsignedBuild,
        "notarize": false,
        "entitlements": "./scripts/entitlements.mac.plist",
        "entitlementsInherit": "./scripts/entitlements.mac.plist",
        "extendInfo": {
            "NSContactsUsageDescription": "BlueBubbles needs access to your Contacts",
            "NSAppleEventsUsageDescription": "BlueBubbles needs access to run AppleScripts",
            "NSSystemAdministrationUsageDescription": "BlueBubbles needs access to manage your system",
        },
        "gatekeeperAssess": false,
        "minimumSystemVersion": "10.11.0",
        "signIgnore": [
            "ngrok$",
            "zrok$",
            "cloudflared$"
        ],
        ...(isUnsignedBuild ? {} : {
            "publish": [
                {
                    "provider": "github",
                    "repo": "bluebubbles-server",
                    "owner": "BlueBubblesApp",
                    "private": false,
                    "channel": "latest",
                    "releaseType": "draft",
                    "vPrefixedTagName": true
                }
            ],
            "type": "distribution"
        })
    },
    "dmg": {
        "sign": false,
        "writeUpdateInfo": false
    },
    // "afterSign": "./scripts/notarize.js"
};
