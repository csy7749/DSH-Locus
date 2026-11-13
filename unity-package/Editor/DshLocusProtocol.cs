// Shared envelope, error, and instance-record types for the dsh-locus bridge.

using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;

namespace DshLocus
{
    public sealed class DshLocusException : Exception
    {
        public readonly string Code;
        public readonly object Detail;

        public DshLocusException(string code, string message) : base(message)
        {
            Code = code;
        }

        public DshLocusException(string code, string message, object detail) : base(message)
        {
            Code = code;
            Detail = detail;
        }
    }

    public sealed class DshLocusRequest
    {
        public string Id;
        public string Method;
        public Dictionary<string, object> Args;
        public bool Authenticated;

        public readonly ManualResetEventSlim Completed = new ManualResetEventSlim(false);
        public string ResponseLine;

        public string GetString(string key)
        {
            object value;
            if (Args != null && Args.TryGetValue(key, out value) && value is string) return (string)value;
            return null;
        }

        public int GetInt(string key, int fallback)
        {
            object value;
            if (Args != null && Args.TryGetValue(key, out value))
            {
                if (value is long) return (int)(long)value;
                if (value is double) return (int)(double)value;
            }
            return fallback;
        }

        public bool GetBool(string key, bool fallback)
        {
            object value;
            if (Args != null && Args.TryGetValue(key, out value) && value is bool) return (bool)value;
            return fallback;
        }
    }

    public static class DshLocusEnvelope
    {
        public static string Success(string id, object result)
        {
            var payload = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "id", id },
                { "ok", true },
                { "result", result },
            };
            return DshLocusJson.Encode(payload) + "\n";
        }

        public static string Failure(string id, string code, string message, object detail)
        {
            var error = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "code", code },
                { "message", message },
            };
            if (detail != null) error["detail"] = detail;
            var payload = new Dictionary<string, object>(StringComparer.Ordinal)
            {
                { "id", id },
                { "ok", false },
                { "error", error },
            };
            return DshLocusJson.Encode(payload) + "\n";
        }

        public static Dictionary<string, object> Dict()
        {
            return new Dictionary<string, object>(StringComparer.Ordinal);
        }

        public static Dictionary<string, object> Dict(params object[] pairs)
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            for (var index = 0; index + 1 < pairs.Length; index += 2)
            {
                result[(string)pairs[index]] = pairs[index + 1];
            }
            return result;
        }
    }

    /// <summary>
    /// Path normalization and identity rules shared with the DSH plugin.
    /// docs/PROTOCOL.md is the normative description; change both sides together.
    /// </summary>
    public static class DshLocusPaths
    {
        public static string NormalizeProjectPath(string value)
        {
            if (value == null) return string.Empty;
            var text = value.Trim();
            if (text.StartsWith(@"\\?\", StringComparison.Ordinal)) text = text.Substring(4);
            text = text.Replace('/', '\\');
            text = text.TrimEnd('\\');
            return text.ToLowerInvariant();
        }

        public static string Key(string projectPath)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(NormalizeProjectPath(projectPath)));
                var builder = new StringBuilder(16);
                for (var index = 0; index < 8; index++) builder.Append(bytes[index].ToString("x2"));
                return builder.ToString();
            }
        }

        public static string StateDirectory()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return System.IO.Path.Combine(local, "dsh-locus");
        }

        public static string InstancesDirectory()
        {
            return System.IO.Path.Combine(StateDirectory(), "instances");
        }

        public static string ProjectRoot()
        {
            // Application.dataPath is <project>/Assets.
            var parent = System.IO.Directory.GetParent(UnityEngine.Application.dataPath);
            return parent == null ? UnityEngine.Application.dataPath : parent.FullName;
        }
    }
}
