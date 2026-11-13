// Roslyn-based C# execution inside the Unity editor.
//
// The Roslyn assemblies ship with this package under Editor/Roslyn (MIT, see
// NOTICE); they are editor-only and never enter a player build.
//
// Why this compiles a class instead of using CSharpScript: Unity's Mono throws
// NotImplementedException from CoreAssemblyLoaderImpl.LoadFromStream, which is
// where Microsoft.CodeAnalysis.Scripting tries to load the assembly it just
// emitted ("The method or operation is not implemented", observed on
// 2021.3.18f1). Assembly.Load(byte[]) does work there, so we build a tiny class
// with Roslyn, emit it to memory, load the bytes, and invoke it by reflection.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace DshLocus
{
    public static class DshLocusExecute
    {
        private const string RunnerTypeName = "DshLocusGeneratedScript";
        private const string RunnerMethodName = "__Run";

        private static readonly string[] Imports =
        {
            "System",
            "System.Collections.Generic",
            "System.Linq",
            "System.IO",
            "System.Text",
            "System.Threading.Tasks",
            "UnityEngine",
            "UnityEditor",
            "UnityEngine.SceneManagement",
        };

        private static List<MetadataReference> cachedReferences;
        private static int cachedReferenceCount = -1;

        public static Dictionary<string, object> Run(string code)
        {
            var watch = Stopwatch.StartNew();
            var output = new StringWriter(CultureInfo.InvariantCulture);
            var previous = Console.Out;
            Console.SetOut(output);
            try
            {
                string hoistedUsings;
                string body;
                SplitUsings(code ?? string.Empty, out hoistedUsings, out body);
                var isAsync = body.IndexOf("await ", StringComparison.Ordinal) >= 0;

                var source = BuildSource(hoistedUsings, body, isAsync);
                var compilation = CSharpCompilation.Create(
                    "DshLocusScript_" + Guid.NewGuid().ToString("N"),
                    new[] { CSharpSyntaxTree.ParseText(SourceText.From(source), new CSharpParseOptions(LanguageVersion.CSharp9)) },
                    References(),
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                        optimizationLevel: OptimizationLevel.Debug,
                        allowUnsafe: false,
                        concurrentBuild: false));

                byte[] image;
                using (var stream = new MemoryStream())
                {
                    var emitted = compilation.Emit(stream);
                    var errors = emitted.Diagnostics
                        .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                        .ToList();
                    if (!emitted.Success || errors.Count > 0) return Result(false, output, null, errors, watch);
                    image = stream.ToArray();
                }

                var assembly = Assembly.Load(image);
                var type = assembly.GetType(RunnerTypeName, true);
                var method = type.GetMethod(RunnerMethodName, BindingFlags.Public | BindingFlags.Static);
                object value;
                // Unity installs a SynchronizationContext that posts every await
                // continuation back to the main loop. We are *inside* the main loop
                // here, so awaiting anything would deadlock the editor (observed:
                // "await Task.Delay(30)" froze Unity). Clearing the context makes
                // continuations resume on the thread pool instead. The cost is that
                // Unity API calls after an await now raise Unity's own
                // "can only be called from the main thread" error, which is a clear
                // message rather than a frozen editor.
                var context = System.Threading.SynchronizationContext.Current;
                System.Threading.SynchronizationContext.SetSynchronizationContext(null);
                try
                {
                    value = method.Invoke(null, null);
                    if (isAsync && value is Task task)
                    {
                        task.GetAwaiter().GetResult();
                        var resultProperty = task.GetType().GetProperty("Result");
                        value = resultProperty == null ? null : resultProperty.GetValue(task, null);
                    }
                }
                catch (TargetInvocationException error)
                {
                    // Surface the user's exception, not the reflection wrapper.
                    if (error.InnerException != null) throw error.InnerException;
                    throw;
                }
                finally
                {
                    System.Threading.SynchronizationContext.SetSynchronizationContext(context);
                }
                return Result(true, output, value, null, watch);
            }
            finally
            {
                Console.SetOut(previous);
            }
        }

        /// <summary>
        /// Pulls leading <c>using</c> directives out of the snippet: they are legal
        /// at the top of a script but not inside a method body.
        /// </summary>
        private static void SplitUsings(string code, out string usings, out string body)
        {
            var lines = code.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            var hoisted = new List<string>();
            var index = 0;
            for (; index < lines.Length; index++)
            {
                var trimmed = lines[index].Trim();
                if (trimmed.Length == 0) continue;
                if (trimmed.StartsWith("using ", StringComparison.Ordinal) && trimmed.EndsWith(";", StringComparison.Ordinal))
                {
                    hoisted.Add(trimmed);
                    continue;
                }
                break;
            }
            usings = string.Join("\n", hoisted);
            body = string.Join("\n", lines.Skip(index));
        }

        private static string BuildSource(string hoistedUsings, string body, bool isAsync)
        {
            var builder = new System.Text.StringBuilder();
            builder.AppendLine("// Generated by dsh-locus; not written to disk.");
            foreach (var import in Imports) builder.Append("using ").Append(import).AppendLine(";");
            if (hoistedUsings.Length > 0) builder.AppendLine(hoistedUsings);
            builder.AppendLine("public static class " + RunnerTypeName + " {");
            builder.Append("    public static ").Append(isAsync ? "async System.Threading.Tasks.Task<object>" : "object")
                .Append(' ').Append(RunnerMethodName).AppendLine("() {");
            builder.AppendLine("#line 1");
            builder.AppendLine(body);
            builder.AppendLine("#line default");
            builder.AppendLine("        return null;");
            builder.AppendLine("    }");
            builder.AppendLine("}");
            return builder.ToString();
        }

        private static Dictionary<string, object> Result(bool compiled, StringWriter output, object value, List<Diagnostic> errors, Stopwatch watch)
        {
            var lines = new List<object>();
            foreach (var line in output.ToString().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)) lines.Add(line);
            var result = DshLocusEnvelope.Dict(
                "compiled", compiled,
                "output", lines,
                "durationMs", watch.ElapsedMilliseconds);
            if (value != null) result["result"] = Describe(value);
            if (errors != null && errors.Count > 0)
            {
                var list = new List<object>();
                foreach (var error in errors)
                {
                    // GetMappedLineSpan, not GetLineSpan: the latter ignores the
                    // #line directive and reports the generated file's line numbers.
                    var position = error.Location.GetMappedLineSpan().StartLinePosition;
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

        private static List<MetadataReference> References()
        {
            var assemblies = AppDomain.CurrentDomain.GetAssemblies()
                .Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(SafeLocation(assembly)))
                .ToList();
            if (cachedReferences != null && cachedReferenceCount == assemblies.Count) return cachedReferences;

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
                    // them only costs the snippet access to that assembly's types.
                }
            }
            cachedReferences = references;
            cachedReferenceCount = assemblies.Count;
            return references;
        }

        private static string SafeLocation(Assembly assembly)
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
