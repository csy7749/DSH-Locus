// Loopback TCP server that receives dsh-locus requests and runs them on the
// Unity main thread. See docs/PROTOCOL.md for the wire contract.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace DshLocus
{
    [InitializeOnLoad]
    public static class DshLocusServer
    {
        private const int MaxLineBytes = 16 * 1024 * 1024;
        private const int RequestWaitSeconds = 300;
        private const string DisabledPrefKey = "DshLocus.Disabled";

        private static TcpListener listener;
        private static Thread acceptThread;
        private static volatile bool running;
        private static string token;
        private static int port;
        private static string instanceFile;
        private static readonly ConcurrentQueue<DshLocusRequest> queue = new ConcurrentQueue<DshLocusRequest>();
        private static readonly List<TcpClient> clients = new List<TcpClient>();

        public static bool IsRunning { get { return running; } }
        public static int Port { get { return port; } }
        public static string ProjectPath { get { return DshLocusPaths.ProjectRoot(); } }

        static DshLocusServer()
        {
            if (EditorPrefs.GetBool(DisabledPrefKey, false)) return;
            EditorApplication.delayCall += Start;
        }

        [MenuItem("Tools/dsh-locus/Enable bridge", false, 20)]
        private static void MenuEnable()
        {
            EditorPrefs.SetBool(DisabledPrefKey, false);
            Start();
        }

        [MenuItem("Tools/dsh-locus/Disable bridge", false, 21)]
        private static void MenuDisable()
        {
            Stop();
            EditorPrefs.SetBool(DisabledPrefKey, true);
        }

        [MenuItem("Tools/dsh-locus/Show bridge status", false, 22)]
        private static void MenuStatus()
        {
            if (!running)
            {
                Debug.Log("[dsh-locus] Bridge is stopped. Use Tools > dsh-locus > Enable bridge.");
                return;
            }
            Debug.Log(string.Format(CultureInfo.InvariantCulture,
                "[dsh-locus] Bridge listening on 127.0.0.1:{0} for {1}\nInstance file: {2}",
                port, ProjectPath, instanceFile));
        }

        public static void Start()
        {
            if (running) return;
            try
            {
                DshLocusConsole.Hook();
                token = NewToken();
                listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                port = ((IPEndPoint)listener.LocalEndpoint).Port;
                running = true;
                WriteInstanceFile();
                acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "dsh-locus-accept" };
                acceptThread.Start();
                EditorApplication.update -= Pump;
                EditorApplication.update += Pump;
                EditorApplication.quitting -= Stop;
                EditorApplication.quitting += Stop;
                AssemblyReloadEvents.beforeAssemblyReload -= Stop;
                AssemblyReloadEvents.beforeAssemblyReload += Stop;
                Debug.Log(string.Format(CultureInfo.InvariantCulture, "[dsh-locus] Bridge started on 127.0.0.1:{0} for {1}", port, ProjectPath));
            }
            catch (Exception error)
            {
                running = false;
                Debug.LogError("[dsh-locus] Failed to start the bridge: " + error);
            }
        }

        public static void Stop()
        {
            if (!running && listener == null) return;
            running = false;
            EditorApplication.update -= Pump;
            try { if (listener != null) listener.Stop(); } catch { }
            listener = null;
            lock (clients)
            {
                foreach (var client in clients)
                {
                    try { client.Close(); } catch { }
                }
                clients.Clear();
            }
            if (!string.IsNullOrEmpty(instanceFile))
            {
                try { File.Delete(instanceFile); } catch { }
                instanceFile = null;
            }
            acceptThread = null;
        }

        private static string NewToken()
        {
            var bytes = new byte[16];
            using (var random = System.Security.Cryptography.RandomNumberGenerator.Create()) random.GetBytes(bytes);
            var builder = new StringBuilder(32);
            foreach (var value in bytes) builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            return builder.ToString();
        }

        private static void WriteInstanceFile()
        {
            var directory = DshLocusPaths.InstancesDirectory();
            Directory.CreateDirectory(directory);
            var root = ProjectPath;
            var record = DshLocusEnvelope.Dict(
                "app", "unity",
                "key", DshLocusPaths.Key(root),
                "pid", Process.GetCurrentProcess().Id,
                "port", port,
                "token", token,
                "projectPath", root,
                "projectName", new DirectoryInfo(root).Name,
                "version", Application.unityVersion,
                "startedAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            instanceFile = Path.Combine(directory, DshLocusPaths.Key(root) + ".json");
            var temporary = instanceFile + "." + Process.GetCurrentProcess().Id + ".tmp";
            File.WriteAllText(temporary, DshLocusJson.Encode(record), new UTF8Encoding(false));
            if (File.Exists(instanceFile)) File.Delete(instanceFile);
            File.Move(temporary, instanceFile);
        }

        private static void AcceptLoop()
        {
            while (running)
            {
                TcpClient client;
                try
                {
                    client = listener.AcceptTcpClient();
                }
                catch (Exception)
                {
                    if (!running) return;
                    Thread.Sleep(100);
                    continue;
                }
                ThreadPool.QueueUserWorkItem(ServeClient, client);
            }
        }

        private static void ServeClient(object state)
        {
            var client = (TcpClient)state;
            lock (clients) clients.Add(client);
            try
            {
                client.NoDelay = true;
                using (client)
                using (var stream = client.GetStream())
                using (var reader = new StreamReader(stream, new UTF8Encoding(false), false, 8192))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true })
                {
                    var authenticated = false;
                    string line;
                    while (running && (line = reader.ReadLine()) != null)
                    {
                        if (line.Length == 0) continue;
                        if (line.Length > MaxLineBytes)
                        {
                            writer.Write(DshLocusEnvelope.Failure("?", "BAD_REQUEST", "Request line exceeds the 16 MiB limit.", null));
                            break;
                        }
                        var close = false;
                        var response = ProcessLine(line, ref authenticated, ref close);
                        if (response != null) writer.Write(response);
                        if (close) break;
                    }
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
            catch (Exception error)
            {
                Debug.LogWarning("[dsh-locus] Client connection failed: " + error.Message);
            }
            finally
            {
                lock (clients) clients.Remove(client);
            }
        }

        private static string ProcessLine(string line, ref bool authenticated, ref bool close)
        {
            var id = "?";
            try
            {
                var envelope = DshLocusJson.ParseObject(line);
                object idValue;
                if (envelope.TryGetValue("id", out idValue) && idValue != null)
                {
                    id = Convert.ToString(idValue, CultureInfo.InvariantCulture);
                }
                object methodValue;
                if (!envelope.TryGetValue("method", out methodValue) || !(methodValue is string))
                {
                    return DshLocusEnvelope.Failure(id, "BAD_REQUEST", "Every request needs a string \"method\".", null);
                }
                var method = (string)methodValue;
                Dictionary<string, object> args = null;
                object argsValue;
                if (envelope.TryGetValue("args", out argsValue)) args = argsValue as Dictionary<string, object>;

                if (method == "hello")
                {
                    var supplied = args != null && args.ContainsKey("token") ? args["token"] as string : null;
                    if (supplied != token)
                    {
                        close = true;
                        authenticated = false;
                        return DshLocusEnvelope.Failure(id, "AUTH_REQUIRED", "Invalid instance token. Re-read the instance file in %LOCALAPPDATA%\\dsh-locus\\instances.", null);
                    }
                    authenticated = true;
                    return DshLocusEnvelope.Success(id, HelloRecord());
                }

                if (!authenticated)
                {
                    close = true;
                    return DshLocusEnvelope.Failure(id, "AUTH_REQUIRED", "Send hello with the instance token before any other method.", null);
                }

                var request = new DshLocusRequest { Id = id, Method = method, Args = args, Authenticated = true };
                queue.Enqueue(request);
                if (!request.Completed.Wait(TimeSpan.FromSeconds(RequestWaitSeconds)))
                {
                    return DshLocusEnvelope.Failure(id, "TIMEOUT",
                        "The Unity editor did not run the request in time. It may be compiling, importing, or showing a modal dialog.", null);
                }
                return request.ResponseLine;
            }
            catch (FormatException error)
            {
                return DshLocusEnvelope.Failure(id, "BAD_REQUEST", "Malformed JSON: " + error.Message, null);
            }
            catch (Exception error)
            {
                return DshLocusEnvelope.Failure(id, "EXECUTION_ERROR", error.Message, null);
            }
        }

        private static Dictionary<string, object> HelloRecord()
        {
            return DshLocusEnvelope.Dict(
                "app", "unity",
                "pid", Process.GetCurrentProcess().Id,
                "version", Application.unityVersion,
                "projectPath", ProjectPath,
                "projectName", new DirectoryInfo(ProjectPath).Name,
                "capabilities", DshLocusHandlers.Capabilities());
        }

        private static void Pump()
        {
            if (!running) return;
            var budget = Stopwatch.StartNew();
            DshLocusRequest request;
            while (budget.ElapsedMilliseconds < 50 && queue.TryDequeue(out request))
            {
                try
                {
                    request.ResponseLine = DshLocusEnvelope.Success(request.Id, DshLocusHandlers.Handle(request));
                }
                catch (DshLocusException error)
                {
                    request.ResponseLine = DshLocusEnvelope.Failure(request.Id, error.Code, error.Message, error.Detail);
                }
                catch (Exception error)
                {
                    request.ResponseLine = DshLocusEnvelope.Failure(request.Id, "EXECUTION_ERROR", error.Message,
                        DshLocusEnvelope.Dict("type", error.GetType().Name, "stack", error.StackTrace));
                }
                finally
                {
                    request.Completed.Set();
                }
            }
        }
    }
}
