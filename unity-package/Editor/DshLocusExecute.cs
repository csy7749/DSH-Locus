// Roslyn-based C# script execution inside the Unity editor.
// The Roslyn assemblies ship with this package under Editor/Roslyn (MIT, see
// NOTICE); they are editor-only and never enter a player build.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Scripting;
using Microsoft.CodeAnalysis.Scripting;

namespace DshLocus
{
    /// <summary>Globals type handed to every script; keeps the host extensible.</summary>
    public sealed class DshLocusScriptGlobals
    {
    }

    public static class DshLocusExecute
    {
        private static readonly string[] Imports =
        {
            "System",
            "System.Collections.Generic",
            "System.Linq",
            "System.IO",
            "System.Text",
            "UnityEngine",
            "UnityEditor",
            "UnityEngine.SceneManagement",
        };

        private static ScriptOptions cachedOptions;
        private static int cachedReferenceCount = -1;

        public static Dictionary<string, object> Run(string code)
        {
            var watch = Stopwatch.StartNew();
            var output = new StringWriter(CultureInfo.InvariantCulture);
            var previous = Console.Out;
            Console.SetOut(output);
            try
            {
                var script = CSharpScript.Create(code ?? string.Empty, Options(), typeof(DshLocusScriptGlobals));
                var diagnostics = script.Compile();
                var errors = diagnostics.Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToList();
                if (errors.Count > 0) return Result(false, output, null, errors, watch);

                var state = script.RunAsync(new DshLocusScriptGlobals(), null, CancellationToken.None).GetAwaiter().GetResult();
                return Result(true, output, state.ReturnValue, null, watch);
            }
            catch (CompilationErrorException error)
            {
                return Result(false, output, null, error.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToList(), watch);
            }
            finally
            {
                Console.SetOut(previous);
            }
        }

        private static Dictionary<string, object> Result(bool compiled, StringWriter output, object value, List<Diagnostic> errors, Stopwatch watch)
        {
            var lines = new List<object>();
            foreach (var line in output.ToString().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)) lines.Add(line);
            var result = DshLocusEnvelope.Dict(
                "compiled", compiled,
                "output", lines,
                "durationMs", watch.ElapsedMilliseconds);
            if (value != null)
            {
                var text = value as string;
                result["result"] = text ?? Describe(value);
            }
            if (errors != null && errors.Count > 0)
            {
                var list = new List<object>();
                foreach (var error in errors)
                {
                    var position = error.Location.GetLineSpan().StartLinePosition;
                    list.Add(DshLocusEnvelope.Dict(
                        "message", error.GetMessage(CultureInfo.InvariantCulture),
                        "id", error.Id,
                        "line", position.Line + 1,
                        "column", position.Character + 1));
                }
                result["errors"] = list;
            }
            return result;
        }

        private static string Describe(object value)
        {
            var text = value as string;
            if (text != null) return text;
            try
            {
                return Convert.ToString(value, CultureInfo.InvariantCulture) ?? value.GetType().Name;
            }
            catch (Exception)
            {
                return "<" + value.GetType().Name + ">";
            }
        }

        private static ScriptOptions Options()
        {
            var assemblies = AppDomain.CurrentDomain.GetAssemblies()
                .Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(SafeLocation(assembly)))
                .ToList();
            if (cachedOptions != null && cachedReferenceCount == assemblies.Count) return cachedOptions;

            var references = new List<MetadataReference>();
            foreach (var assembly in assemblies)
            {
                try
                {
                    references.Add(MetadataReference.CreateFromFile(assembly.Location));
                }
                catch (Exception)
                {
                    // A few Unity-managed assemblies are not valid metadata; skipping
                    // them only costs the script access to that assembly's types.
                }
            }
            cachedOptions = ScriptOptions.Default
                .WithReferences(references)
                .WithImports(Imports)
                .WithOptimizationLevel(OptimizationLevel.Debug);
            cachedReferenceCount = assemblies.Count;
            return cachedOptions;
        }

        private static string SafeLocation(System.Reflection.Assembly assembly)
        {
            try
            {
                return assembly.Location;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
