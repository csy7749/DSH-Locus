// Compile-only stubs for the Unity editor APIs used by unity-package/Editor.
//
// These are NOT part of the shipped Unity package. scripts/check-csharp.mjs
// compiles the editor scripts against them so a normal machine (no Unity
// install) can still catch syntax errors, typos, and internal inconsistencies.
// Signatures mirror Unity 2021.3; behaviour is irrelevant because nothing runs.

using System;
using System.Collections.Generic;

namespace UnityEngine
{
    public class Object
    {
        public string name;
        public static implicit operator bool(Object value) { return !ReferenceEquals(value, null); }
    }

    public enum LogType
    {
        Error = 0,
        Assert = 1,
        Warning = 2,
        Log = 3,
        Exception = 4,
    }

    public enum RuntimePlatform
    {
        WindowsPlayer = 2,
        OSXPlayer = 1,
        LinuxPlayer = 13,
        WindowsEditor = 7,
    }

    public static class Application
    {
        public static string unityVersion = "2021.3.18f1";
        public static string version = "2021.3.18f1";
        public static string dataPath = @"C:\Project\Assets";
        public static RuntimePlatform platform = RuntimePlatform.WindowsEditor;
        public static event Action<string, string, LogType> logMessageReceived;
        internal static void Raise(string message, string stack, LogType type) { logMessageReceived?.Invoke(message, stack, type); }
    }

    public static class Debug
    {
        public static void Log(object message) { }
        public static void LogWarning(object message) { }
        public static void LogError(object message) { }
    }
}

namespace UnityEngine.SceneManagement
{
    public struct Scene
    {
        public string path;
        public string name;
        public bool isDirty;
    }
}

namespace UnityEditor
{
    public static class BuildTarget
    {
        public const int StandaloneWindows64 = 19;
    }

    public static class EditorApplication
    {
        public delegate void CallbackFunction();
        public static CallbackFunction update;
        public static CallbackFunction delayCall;
        public static event Action quitting;
        public static bool isPlaying;
        public static bool isPaused;
        public static bool isCompiling;
        public static bool isUpdating;
        public static double timeSinceStartup;
        public static bool ExecuteMenuItem(string menuItemPath) { return true; }
        internal static void RaiseQuitting() { quitting?.Invoke(); }
    }

    public static class EditorPrefs
    {
        public static bool GetBool(string key, bool defaultValue) { return defaultValue; }
        public static void SetBool(string key, bool value) { }
    }

    public static class EditorUserBuildSettings
    {
        public static string activeBuildTarget = "StandaloneWindows64";
    }

    public static class Selection
    {
        public static UnityEngine.Object[] objects = Array.Empty<UnityEngine.Object>();
    }

    public static class AssetDatabase
    {
        public static string[] FindAssets(string filter, string[] searchInFolders = null) { return Array.Empty<string>(); }
        public static string GUIDToAssetPath(string guid) { return string.Empty; }
        public static Type GetMainAssetTypeAtPath(string assetPath) { return null; }
        public static bool IsValidFolder(string path) { return true; }
    }

    [AttributeUsage(AttributeTargets.Class)]
    public sealed class InitializeOnLoadAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.Method)]
    public sealed class MenuItemAttribute : Attribute
    {
        public MenuItemAttribute(string itemName) { }
        public MenuItemAttribute(string itemName, bool isValidateFunction) { }
        public MenuItemAttribute(string itemName, bool isValidateFunction, int priority) { }
    }

    public static class AssemblyReloadEvents
    {
        public static event Action beforeAssemblyReload;
        public static event Action afterAssemblyReload;
        internal static void RaiseBefore() { beforeAssemblyReload?.Invoke(); }
    }
}

namespace UnityEditor.Compilation
{
    public static class CompilationPipeline
    {
        public static void RequestScriptCompilation() { }
    }
}

// InternalEditorUtility lives in UnityEditorInternal, not UnityEditor. The
// stubs previously mirrored our own mistake here, so the stub build passed a
// compile error that real Unity rejects.
namespace UnityEditorInternal
{
    public static class InternalEditorUtility
    {
        public static bool isApplicationActive { get { return true; } }
    }
}

namespace UnityEditor.SceneManagement
{
    public static class EditorSceneManager
    {
        public static UnityEngine.SceneManagement.Scene GetActiveScene() { return new UnityEngine.SceneManagement.Scene(); }
    }
}
