// Minimal JSON reader/writer for the dsh-locus bridge.
// Unity 2021 has no built-in general-purpose JSON API (JsonUtility cannot handle
// dictionaries or dynamic shapes), and the bridge must not depend on a registry
// package just to parse a request envelope.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace DshLocus
{
    public static class DshLocusJson
    {
        public static object Parse(string json)
        {
            var index = 0;
            var value = ParseValue(json, ref index);
            SkipWhitespace(json, ref index);
            if (index != json.Length) throw new FormatException("Unexpected trailing characters at offset " + index);
            return value;
        }

        public static Dictionary<string, object> ParseObject(string json)
        {
            var value = Parse(json);
            var dict = value as Dictionary<string, object>;
            if (dict == null) throw new FormatException("Expected a JSON object");
            return dict;
        }

        public static string Encode(object value)
        {
            var builder = new StringBuilder(256);
            WriteValue(builder, value);
            return builder.ToString();
        }

        private static object ParseValue(string text, ref int index)
        {
            SkipWhitespace(text, ref index);
            if (index >= text.Length) throw new FormatException("Unexpected end of JSON");
            var c = text[index];
            switch (c)
            {
                case '{': return ParseObjectBody(text, ref index);
                case '[': return ParseArrayBody(text, ref index);
                case '"': return ParseStringBody(text, ref index);
                case 't': Expect(text, ref index, "true"); return true;
                case 'f': Expect(text, ref index, "false"); return false;
                case 'n': Expect(text, ref index, "null"); return null;
                default: return ParseNumberBody(text, ref index);
            }
        }

        private static Dictionary<string, object> ParseObjectBody(string text, ref int index)
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            index++; // {
            SkipWhitespace(text, ref index);
            if (index < text.Length && text[index] == '}')
            {
                index++;
                return result;
            }
            while (true)
            {
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != '"') throw new FormatException("Expected an object key at offset " + index);
                var key = ParseStringBody(text, ref index);
                SkipWhitespace(text, ref index);
                if (index >= text.Length || text[index] != ':') throw new FormatException("Expected ':' at offset " + index);
                index++;
                result[key] = ParseValue(text, ref index);
                SkipWhitespace(text, ref index);
                if (index >= text.Length) throw new FormatException("Unterminated object");
                if (text[index] == ',') { index++; continue; }
                if (text[index] == '}') { index++; return result; }
                throw new FormatException("Expected ',' or '}' at offset " + index);
            }
        }

        private static List<object> ParseArrayBody(string text, ref int index)
        {
            var result = new List<object>();
            index++; // [
            SkipWhitespace(text, ref index);
            if (index < text.Length && text[index] == ']')
            {
                index++;
                return result;
            }
            while (true)
            {
                result.Add(ParseValue(text, ref index));
                SkipWhitespace(text, ref index);
                if (index >= text.Length) throw new FormatException("Unterminated array");
                if (text[index] == ',') { index++; continue; }
                if (text[index] == ']') { index++; return result; }
                throw new FormatException("Expected ',' or ']' at offset " + index);
            }
        }

        private static string ParseStringBody(string text, ref int index)
        {
            index++; // opening quote
            var builder = new StringBuilder();
            while (true)
            {
                if (index >= text.Length) throw new FormatException("Unterminated string");
                var c = text[index++];
                if (c == '"') return builder.ToString();
                if (c != '\\')
                {
                    builder.Append(c);
                    continue;
                }
                if (index >= text.Length) throw new FormatException("Unterminated escape");
                var escape = text[index++];
                switch (escape)
                {
                    case '"': builder.Append('"'); break;
                    case '\\': builder.Append('\\'); break;
                    case '/': builder.Append('/'); break;
                    case 'b': builder.Append('\b'); break;
                    case 'f': builder.Append('\f'); break;
                    case 'n': builder.Append('\n'); break;
                    case 'r': builder.Append('\r'); break;
                    case 't': builder.Append('\t'); break;
                    case 'u':
                        if (index + 4 > text.Length) throw new FormatException("Truncated unicode escape");
                        var hex = text.Substring(index, 4);
                        index += 4;
                        builder.Append((char)int.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        break;
                    default: throw new FormatException("Unsupported escape \\" + escape);
                }
            }
        }

        private static object ParseNumberBody(string text, ref int index)
        {
            var start = index;
            while (index < text.Length)
            {
                var c = text[index];
                if (c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' || (c >= '0' && c <= '9')) index++;
                else break;
            }
            if (start == index) throw new FormatException("Expected a value at offset " + start);
            var raw = text.Substring(start, index - start);
            if (raw.IndexOf('.') < 0 && raw.IndexOf('e') < 0 && raw.IndexOf('E') < 0)
            {
                long asLong;
                if (long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out asLong)) return asLong;
            }
            double asDouble;
            if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out asDouble))
                throw new FormatException("Invalid number: " + raw);
            return asDouble;
        }

        private static void SkipWhitespace(string text, ref int index)
        {
            while (index < text.Length)
            {
                var c = text[index];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') index++;
                else break;
            }
        }

        private static void Expect(string text, ref int index, string literal)
        {
            if (index + literal.Length > text.Length || string.CompareOrdinal(text, index, literal, 0, literal.Length) != 0)
                throw new FormatException("Invalid literal at offset " + index);
            index += literal.Length;
        }

        private static void WriteValue(StringBuilder builder, object value)
        {
            if (value == null)
            {
                builder.Append("null");
                return;
            }
            var text = value as string;
            if (text != null)
            {
                WriteString(builder, text);
                return;
            }
            if (value is bool)
            {
                builder.Append((bool)value ? "true" : "false");
                return;
            }
            var dict = value as IDictionary<string, object>;
            if (dict != null)
            {
                builder.Append('{');
                var first = true;
                foreach (var pair in dict)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    WriteString(builder, pair.Key);
                    builder.Append(':');
                    WriteValue(builder, pair.Value);
                }
                builder.Append('}');
                return;
            }
            var enumerable = value as IEnumerable;
            if (enumerable != null)
            {
                builder.Append('[');
                var first = true;
                foreach (var item in enumerable)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    WriteValue(builder, item);
                }
                builder.Append(']');
                return;
            }
            if (value is double || value is float)
            {
                var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (double.IsNaN(number) || double.IsInfinity(number)) builder.Append("null");
                else builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            if (value is IConvertible)
            {
                builder.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                return;
            }
            WriteString(builder, Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        private static void WriteString(StringBuilder builder, string text)
        {
            builder.Append('"');
            for (var i = 0; i < text.Length; i++)
            {
                var c = text[i];
                switch (c)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    case '\b': builder.Append("\\b"); break;
                    case '\f': builder.Append("\\f"); break;
                    default:
                        if (c < ' ')
                        {
                            builder.Append("\\u");
                            builder.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(c);
                        }
                        break;
                }
            }
            builder.Append('"');
        }
    }
}
