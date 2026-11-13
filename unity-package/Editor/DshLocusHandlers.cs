// Request dispatch for the dsh-locus Unity bridge. Every handler runs on the
// Unity main thread, driven by DshLocusServer.Pump().

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace DshLocus
{
    public static class DshLocusHandlers
    {
        private static readonly string[] CapabilityList =
        {
            "status",
            "execute",
            "console",
            "playmode",
            "asset_search",
            "read_asset",
            "menu",
            "recompile",
        };

        /// <summary>Methods this build understands; also reported by hello.</summary>
        public static List<object> Capabilities()
        {
            return CapabilityList.Cast<object>().ToList();
        }

        /// <summary>Run one request; return the JSON-ready result object.</summary>
        public static object Handle(DshLocusRequest request)
        {
            switch (request.Method)
            {
                case "ping": return Ping();
                case "status": return Status();
                case "execute": return Execute(request);
                case "console": return ReadConsole(request);
                case "playmode": return PlayMode(request);
                case "asset_search": return AssetSearch(request);
                case "read_asset": return ReadAsset(request);
                case "menu": return Menu(request);
                case "recompile": return Recompile();
                default:
                    throw new DshLocusException("UNKNOWN_METHOD", "Unknown method \"" + request.Method + "\". This bridge supports: " + string.Join(", ", CapabilityList) + ".");
            }
        }

        private static Dictionary<string, object> Ping()
        {
            return DshLocusEnvelope.Dict(
                "pong", true,
                "app", "unity",
                "pid", Process.GetCurrentProcess().Id,
                "time", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        private static Dictionary<string, object> Status()
        {
            var scene = UnityEditor.SceneManagement.EditorSceneManager.GetActiveScene();
            return DshLocusEnvelope.Dict(
                "app", "unity",
                "projectName", new DirectoryInfo(DshLocusPaths.ProjectRoot()).Name,
                "projectPath", DshLocusPaths.ProjectRoot(),
                "unityVersion", Application.unityVersion,
                "unityVersionShort", Application.version,
                "platform", Application.platform.ToString(),
                "buildTarget", EditorUserBuildSettings.activeBuildTarget.ToString(),
                "activeScenePath", string.IsNullOrEmpty(scene.path) ? null : scene.path,
                "activeSceneName", scene.name,
                "sceneDirty", scene.isDirty,
                "isPlaying", EditorApplication.isPlaying,
                "isPaused", EditorApplication.isPaused,
                "isCompiling", EditorApplication.isCompiling || EditorApplication.isUpdating,
                "isFocused", InternalEditorUtility.isApplicationActive,
                "editorPid", Process.GetCurrentProcess().Id,
                "timeSinceStartup", EditorApplication.timeSinceStartup,
                "selection", Selection.objects == null ? 0 : Selection.objects.Length,
                "capabilities", Capabilities());
        }

        private static Dictionary<string, object> Execute(DshLocusRequest request)
        {
            if (EditorApplication.isCompiling)
            {
                throw new DshLocusException("NOT_READY", "Unity is compiling scripts. Poll unity_status until isCompiling is false, then retry.");
            }
            var mode = request.GetString("mode") ?? "editor";
            if (mode == "play" && !EditorApplication.isPlaying)
            {
                throw new DshLocusException("NOT_READY", "This call requires play mode. Use unity_playmode with action \"play\" first.");
            }
            if (mode == "editor" && EditorApplication.isPlaying)
            {
                throw new DshLocusException("NOT_READY", "The editor is in play mode; script execution only reaches editor objects. Stop play mode or pass mode \"play\".");
            }
            return DshLocusExecute.Run(request.GetString("code") ?? string.Empty);
        }

        private static Dictionary<string, object> ReadConsole(DshLocusRequest request)
        {
            return DshLocusConsole.Read(request.GetInt("limit", 50), request.GetString("level") ?? "all");
        }

        private static Dictionary<string, object> PlayMode(DshLocusRequest request)
        {
            var action = request.GetString("action");
            switch (action)
            {
                case "play":
                    if (!EditorApplication.isPlaying) EditorApplication.isPlaying = true;
                    break;
                case "pause":
                    if (!EditorApplication.isPlaying)
                    {
                        throw new DshLocusException("NOT_READY", "Play mode is not running, so it cannot be paused. Use action \"play\" first.");
                    }
                    EditorApplication.isPaused = !EditorApplication.isPaused;
                    break;
                case "stop":
                    if (!EditorApplication.isPlaying)
                    {
                        throw new DshLocusException("NOT_READY", "Play mode is not running; there is nothing to stop.");
                    }
                    EditorApplication.isPlaying = false;
                    break;
                default:
                    throw new DshLocusException("BAD_REQUEST", "action must be one of play, pause, stop.");
            }
            return DshLocusEnvelope.Dict(
                "isPlaying", EditorApplication.isPlaying,
                "isPaused", EditorApplication.isPaused,
                "requested", action);
        }

        private static readonly Dictionary<string, string> TypeFilters = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "script", "t:MonoScript" },
            { "prefab", "t:Prefab" },
            { "scene", "t:SceneAsset" },
            { "material", "t:Material" },
            { "animation", "t:AnimationClip" },
            { "texture", "t:Texture2D" },
            { "audio", "t:AudioClip" },
            { "model", "t:GameObject" },
        };

        private static bool MatchesExtension(string assetPath, string type)
        {
            var extension = Path.GetExtension(assetPath).ToLowerInvariant();
            switch (type)
            {
                case "model": return extension == ".fbx" || extension == ".obj" || extension == ".blend" || extension == ".dae" || extension == ".3ds";
                case "prefab": return extension == ".prefab";
                default: return true;
            }
        }

        private static Dictionary<string, object> AssetSearch(DshLocusRequest request)
        {
            var query = (request.GetString("query") ?? string.Empty).Trim();
            var type = request.GetString("type") ?? "all";
            var limit = request.GetInt("limit", 20);
            if (limit < 1) limit = 1;
            if (limit > 200) limit = 200;

            var filter = query;
            string typeFilter;
            if (type != "all" && TypeFilters.TryGetValue(type, out typeFilter))
            {
                filter = string.IsNullOrEmpty(query) ? typeFilter : query + " " + typeFilter;
            }

            var folder = request.GetString("folder");
            string[] folders = null;
            if (!string.IsNullOrEmpty(folder))
            {
                var normalized = folder.Replace('\\', '/').TrimEnd('/');
                if (!normalized.StartsWith("Assets", StringComparison.OrdinalIgnoreCase) &&
                    !normalized.StartsWith("Packages", StringComparison.OrdinalIgnoreCase))
                {
                    throw new DshLocusException("BAD_REQUEST", "folder must start with \"Assets\" or \"Packages\".");
                }
                if (!AssetDatabase.IsValidFolder(normalized))
                {
                    throw new DshLocusException("BAD_REQUEST", "No such project folder: " + normalized);
                }
                folders = new[] { normalized };
            }

            string[] guids;
            try
            {
                guids = AssetDatabase.FindAssets(filter, folders);
            }
            catch (Exception error)
            {
                throw new DshLocusException("BAD_REQUEST", "AssetDatabase.FindAssets failed: " + error.Message);
            }

            var results = new List<object>();
            foreach (var guid in guids)
            {
                var assetPath = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(assetPath)) continue;
                if (!MatchesExtension(assetPath, type)) continue;
                var assetType = AssetDatabase.GetMainAssetTypeAtPath(assetPath);
                results.Add(DshLocusEnvelope.Dict(
                    "path", assetPath,
                    "guid", guid,
                    "name", Path.GetFileNameWithoutExtension(assetPath),
                    "type", assetType == null ? "unknown" : assetType.Name));
                if (results.Count >= limit) break;
            }
            return DshLocusEnvelope.Dict(
                "results", results,
                "truncated", guids.Length > results.Count,
                "total", guids.Length);
        }

        private static Dictionary<string, object> ReadAsset(DshLocusRequest request)
        {
            var requested = request.GetString("path");
            if (string.IsNullOrEmpty(requested))
            {
                throw new DshLocusException("BAD_REQUEST", "path is required.");
            }
            var maxBytes = request.GetInt("maxBytes", 16384);
            if (maxBytes < 1024) maxBytes = 1024;
            if (maxBytes > 262144) maxBytes = 262144;

            var root = DshLocusPaths.ProjectRoot();
            var full = Path.GetFullPath(Path.IsPathRooted(requested) ? requested : Path.Combine(root, requested.Replace('/', Path.DirectorySeparatorChar)));
            var rootWithSeparator = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!full.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase))
            {
                throw new DshLocusException("BAD_REQUEST", "path must stay inside the Unity project: " + root);
            }
            if (!File.Exists(full))
            {
                throw new DshLocusException("BAD_REQUEST", "No such file: " + full);
            }

            var info = new FileInfo(full);
            var bytes = File.ReadAllBytes(full);
            var slice = bytes.Length > maxBytes ? new byte[maxBytes] : bytes;
            if (bytes.Length > maxBytes) Array.Copy(bytes, slice, maxBytes);
            var isText = LooksLikeText(slice);
            var result = DshLocusEnvelope.Dict(
                "path", full.Substring(rootWithSeparator.Length).Replace('\\', '/'),
                "absolutePath", full,
                "size", info.Length,
                "bytesRead", slice.Length,
                "truncated", bytes.Length > slice.Length,
                "isText", isText);
            if (isText)
            {
                // Drop a partial UTF-8 sequence at the truncation point; Unity
                // assets are UTF-8 and the encoder replaces lone surrogates anyway.
                result["text"] = Encoding.UTF8.GetString(slice, 0, slice.Length).TrimEnd('\uFFFD');
            }
            else
            {
                result["base64"] = Convert.ToBase64String(slice);
            }
            return result;
        }

        private static bool LooksLikeText(byte[] bytes)
        {
            var limit = Math.Min(bytes.Length, 8192);
            for (var index = 0; index < limit; index++)
            {
                if (bytes[index] == 0) return false;
            }
            return true;
        }

        private static Dictionary<string, object> Menu(DshLocusRequest request)
        {
            var path = request.GetString("path");
            if (string.IsNullOrEmpty(path))
            {
                throw new DshLocusException("BAD_REQUEST", "path is required, for example \"File/Save Project\".");
            }
            var executed = EditorApplication.ExecuteMenuItem(path);
            return DshLocusEnvelope.Dict("executed", executed, "path", path);
        }

        private static Dictionary<string, object> Recompile()
        {
            CompilationPipeline.RequestScriptCompilation();
            return DshLocusEnvelope.Dict("requested", true, "isCompiling", EditorApplication.isCompiling);
        }
    }
}
