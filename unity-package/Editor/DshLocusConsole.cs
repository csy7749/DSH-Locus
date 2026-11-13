// Ring buffer over Unity console messages, exposed to the DSH plugin.

using System;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

namespace DshLocus
{
    public static class DshLocusConsole
    {
        private const int Capacity = 2000;
        private const int TrimBatch = 500;

        private sealed class Entry
        {
            public int Index;
            public string Time;
            public string Level;
            public string Message;
            public string Stack;
        }

        private static readonly List<Entry> entries = new List<Entry>();
        private static int total;
        private static bool hooked;

        public static void Hook()
        {
            if (hooked) return;
            hooked = true;
            Application.logMessageReceived += OnLog;
        }

        private static void OnLog(string condition, string stackTrace, LogType type)
        {
            var entry = new Entry
            {
                Time = DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture),
                Level = LevelOf(type),
                Message = condition,
                Stack = string.IsNullOrEmpty(stackTrace) ? null : stackTrace,
            };
            lock (entries)
            {
                total++;
                entry.Index = total;
                entries.Add(entry);
                if (entries.Count > Capacity) entries.RemoveRange(0, TrimBatch);
            }
        }

        private static string LevelOf(LogType type)
        {
            switch (type)
            {
                case LogType.Warning: return "warning";
                case LogType.Error:
                case LogType.Exception:
                case LogType.Assert: return "error";
                default: return "log";
            }
        }

        private static int Rank(string level)
        {
            if (level == "error") return 2;
            if (level == "warning") return 1;
            return 0;
        }

        /// <summary>
        /// Newest-last slice of the console, filtered by a minimum severity.
        /// </summary>
        public static Dictionary<string, object> Read(int limit, string level)
        {
            if (limit < 1) limit = 1;
            if (limit > 500) limit = 500;
            var threshold = Rank(level ?? "all");
            var selected = new List<object>();
            lock (entries)
            {
                for (var index = entries.Count - 1; index >= 0 && selected.Count < limit; index--)
                {
                    var entry = entries[index];
                    if (Rank(entry.Level) < threshold) continue;
                    selected.Add(DshLocusEnvelope.Dict(
                        "index", entry.Index,
                        "time", entry.Time,
                        "level", entry.Level,
                        "message", entry.Message,
                        "stack", entry.Stack));
                }
                selected.Reverse();
                return DshLocusEnvelope.Dict(
                    "entries", selected,
                    "total", total,
                    "dropped", Math.Max(0, total - entries.Count));
            }
        }
    }
}
