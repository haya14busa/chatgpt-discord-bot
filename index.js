const { ApplicationCommandOptionType , Client, GatewayIntentBits } = require('discord.js');
const { token, openaiApiKey } = require('./config.json');
const { Configuration, OpenAIApi } = require("openai");

const configuration = new Configuration({
    apiKey: openaiApiKey,
});
const openai = new OpenAIApi(configuration);

const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

bot.once('ready', () => {
    console.log('Bot is ready!');

    // Register the chat and restart commands
    bot.application.commands.create({
        name: 'chat',
        description: 'Start a conversation with the ChatGPT bot.',
        options: [
            {
                name: 'message',
                description: 'The message you want to send to ChatGPT.',
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    });

    bot.application.commands.create({
        name: 'restart',
        description: 'Restart the conversation with ChatGPT in the thread.',
    });
});

bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName } = interaction;

    if (commandName === 'chat') {
        handleChatCommand(interaction);
    } else if (commandName === 'restart') {
        handleRestartCommand(interaction);
    }
});

async function generateGptResponse(prompt, conversationHistory) {
    // Convert the conversation history to the required format
    const historyMessages = conversationHistory.map((msg) => ({
        role: msg.author.bot ? 'assistant' : 'user',
        content: msg.content,
    }));

    try {
        // Add the user's latest message to the messages array
        historyMessages.push({ role: 'user', content: prompt });

        // Prepend the system message to set the context for the assistant
        historyMessages.unshift({ role: 'system', content: 'You are a helpful assistant. Reply to messages briefly and clearly.' });

        // console.log(historyMessages);

        const response = await openai.createChatCompletion({
            // model: 'gpt-3.5-turbo',
            model: 'gpt-4',
            messages: historyMessages,
        });

        const reply = response.data.choices[0].message.content;
        return reply;
    } catch (error) {
        console.error('Error generating GPT response:', error);
        return 'An error occurred while generating a response. Please try again.';
    }
}

async function handleChatCommand(interaction) {
    if (interaction.channel.isThread()) {
        await interaction.reply("This command cannot be used in a thread.");
        return;
    }
    await interaction.deferReply({ ephemeral: true });

    const userInput = interaction.options.getString('message');


    // Send the first message to the thread
    const reply = await generateGptResponse(userInput, []);
    // Create a thread for the conversation with the userInput as the name
    const thread = await interaction.channel.threads.create({
        name: `chatgpt-${userInput.slice(0, 90)}`, // Truncate the message to fit within the 100 character limit
        autoArchiveDuration: 60,
    });
    await thread.send(`${interaction.user}: ${userInput}\nChatGPT: ${reply}`);

    await interaction.followUp({ content: 'Created a thread', ephemeral: true });

    // Set up the collector
    setupCollector(thread, handleCollectorEnd);
}

async function handleRestartCommand(interaction) {
    if (!interaction.channel.isThread()) {
        await interaction.reply("This command can only be used in a thread.");
        return;
    }

    const thread = interaction.channel;

    // // Stop the existing collector and set up a new one
    // const existingCollector = thread.messageCollectors.first();
    // if (existingCollector) existingCollector.stop();

    setupCollector(thread, handleCollectorEnd);

    await interaction.reply({ content: "Collector restarted. You can continue your conversation with ChatGPT now.", ephemeral: true });
}

async function handleCollectorEnd(reason, thread) {

    if (reason === 'idle') {
        // Leave an instruction message when the thread is closed due to idle duration
        await thread.send({content: "The conversation with ChatGPT has ended due to inactivity. To restart the conversation, please use the `/restart` command within the thread.", ephemeral: true});
    }
    await thread.setArchived(true);
}

async function setupCollector(thread, stopCallback) {
    // Handle messages within the thread
    const collector = thread.createMessageCollector({
        filter: (msg) => !msg.author.bot,
        idle: 30 * 60 * 1000, // 30 minutes of inactivity
    });

    collector.on('collect', async (msg) => {
        // Get the previous messages in the thread
        const previousMessages = await thread.messages.fetch({ limit: 100 });

        // Sort messages by timestamp
        const sortedMessages = Array.from(previousMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp).values());
        // Drop the last message if it's the same as the prompt.
        if (sortedMessages.length > 0 && msg.content === sortedMessages[sortedMessages.length - 1].content) {
          sortedMessages.pop();
        }

        thread.sendTyping();
        const maxBytes = 4096;
        const reply = await generateGptResponse(msg.content, truncateHistory(sortedMessages, maxBytes));
        await thread.send(reply);
    });

    collector.on('end', async (collected, reason) => {
        await stopCallback(reason, thread);
    });
}

function truncateHistory(history, maxBytes) {
    let currentBytes = 0;
    const truncatedHistory = [];

    for (let i = history.length - 1; i >= 0; i--) {
        const message = history[i];
        const role = message.author.bot ? 'assistant' : 'user';
        const content = message.content;

        const messageBytes = Buffer.byteLength(role) + Buffer.byteLength(content) + 4; // 4 bytes for JSON separators
        currentBytes += messageBytes;

        if (currentBytes <= maxBytes) {
            truncatedHistory.unshift(message);
        } else {
            break;
        }
    }

    return truncatedHistory;
}

bot.login(token);
