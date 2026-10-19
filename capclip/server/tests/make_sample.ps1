# Builds a synthetic "talk" video for end-to-end testing using the Windows
# speech synthesizer (no downloads). Output: tests/sample/talk.wav
param([string]$Out = "$PSScriptRoot\sample\talk.wav")
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = 0
$s.SetOutputToWaveFile($Out)
$ssml = @'
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
Hey everyone, welcome back to the channel. Before we get started, don't forget to like and subscribe. <break time="1200ms"/>
Today we're talking about sleep, focus, and the habits that actually move the needle. <break time="2000ms"/>

Here's the truth nobody tells you about productivity. Working longer hours does not make you more productive. <break time="600ms"/>
In fact, after about fifty hours a week, output per hour drops so sharply that the extra time adds almost nothing. <break time="900ms"/>
Um, so what actually works? <break time="700ms"/> Protecting your first two hours. <break time="500ms"/>
Your brain is sharpest in the morning, and most people spend that window answering email. <break time="400ms"/>
Move the email to the afternoon, and use the morning for the one task that really matters. <break time="600ms"/>
That single change gave me back more focused time than any app I have ever tried. <break time="2500ms"/>

Let me tell you a story. <break time="500ms"/> Three years ago I was working until midnight every single night. <break time="600ms"/>
I thought I was being disciplined. I was actually exhausted, and my work was getting worse. <break time="700ms"/>
One day my manager pulled me aside and asked a simple question. <break time="500ms"/> When was the last time you slept eight hours? <break time="1400ms"/>
I could not remember. <break time="800ms"/> So I tried an experiment. For thirty days, lights out at ten thirty, no phone in the bedroom. <break time="600ms"/>
By the second week, I was finishing my hardest work before lunch. <break time="500ms"/> And by the end of the month, I had shipped the project I had been stuck on for half a year. <break time="600ms"/>
That's why I tell everyone the same thing. Sleep is not a reward for finishing your work. It is how the work gets done. <break time="3000ms"/>

Okay, quick tip for anyone who struggles to focus. <break time="400ms"/> Try the two minute rule. <break time="500ms"/>
If a task takes less than two minutes, do it right now. <break time="400ms"/> If it takes longer, write it down and schedule it. <break time="500ms"/>
This sounds simple, but it removes the background noise of a hundred tiny unfinished things. <break time="500ms"/>
Your mind stops juggling, and you can finally give one problem your full attention. <break time="600ms"/>
The result is that you feel calmer, and you get more done in less time. <break time="2200ms"/>

Why do we feel busy all day but accomplish so little? <break time="900ms"/>
The answer is context switching. <break time="500ms"/> Every time you jump between tasks, your brain needs several minutes to fully refocus. <break time="500ms"/>
Researchers have found it can take more than twenty minutes to get back to deep work after an interruption. <break time="600ms"/>
Multiply that by fifty notifications a day, and you can see where the hours go. <break time="500ms"/>
So the fix is not working harder. The fix is fewer switches. <break time="400ms"/> Batch your messages, silence notifications, and give each block of time a single job. <break time="2000ms"/>

Thanks for watching. If you found this useful, check out the link in the description, and I'll see you in the next video.
</speak>
'@
$s.SpeakSsml($ssml)
$s.Dispose()
Write-Output "wrote $Out"
