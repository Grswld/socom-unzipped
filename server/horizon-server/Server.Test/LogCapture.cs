// LOCAL (socom_pc): captures the warnings the server logs through DotNetty's InternalLoggerFactory during one test
// flow (an AsyncLocal marks the flow, so tests running in parallel do not see each other's lines).
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using DotNetty.Common.Internal.Logging;
using Microsoft.Extensions.Logging;

namespace Server.Test
{
    public sealed class LogCapture : IDisposable
    {
        static readonly AsyncLocal<LogCapture> Current = new AsyncLocal<LogCapture>();
        static readonly object Gate = new object();
        static bool _installed;

        readonly ConcurrentQueue<string> _warnings = new ConcurrentQueue<string>();

        public LogCapture()
        {
            lock (Gate)
            {
                if (!_installed)
                {
                    InternalLoggerFactory.DefaultFactory.AddProvider(new Provider());
                    _installed = true;
                }
            }
            Current.Value = this;
        }

        public IReadOnlyList<string> Warnings => _warnings.ToList();

        public void Dispose() => Current.Value = null;

        sealed class Provider : ILoggerProvider
        {
            public ILogger CreateLogger(string categoryName) => new Sink();
            public void Dispose() { }
        }

        sealed class Sink : ILogger
        {
            public IDisposable BeginScope<TState>(TState state) where TState : notnull => null;
            public bool IsEnabled(LogLevel logLevel) => true;
            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception exception, Func<TState, Exception, string> formatter)
            {
                var capture = Current.Value;
                if (capture != null && logLevel >= LogLevel.Warning)
                    capture._warnings.Enqueue(exception == null ? formatter(state, exception) : formatter(state, exception) + " " + exception.GetType().Name + ": " + exception.Message);
            }
        }
    }
}
